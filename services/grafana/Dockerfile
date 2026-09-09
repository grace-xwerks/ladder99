# dockerfile to build the grafana image.
#
# ------------------------------------------------------------------------
# base image
# ------------------------------------------------------------------------
#
# history, because the pins here were load-bearing and the reasons are not
# obvious from the version numbers alone:
#
#   grafana/grafana:8.2.2   (oct 2021) held for years by a note about an
#                           'Origin not allowed' error behind traefik/teleport.
#                           that was a CSRF origin check added in 8.3.x and is
#                           configuration, not a ceiling - root_url plus
#                           [security] csrf_trusted_origins cover it. meanwhile
#                           8.2.2 predates the fix for CVE-2021-43798, an
#                           unauthenticated path traversal, while .env-example
#                           published grafana on port 80.
#
#   grafana/grafana:10.4.19 a staging post. the dashboards still used
#                           natel-discrete-panel and the legacy `graph` panel,
#                           both AngularJS. grafana 11 turned angular off by
#                           default and 12 removed it, so 11+ would have
#                           rendered those panels empty.
#
# both of those constraints are now gone: every provisioned dashboard in this
# repo is built from native react panels (state-timeline, timeseries, stat,
# table, bargauge, text). there is nothing left that needs angular, so there is
# nothing left holding the version down.
#
# 12.x is where that lands us. angular is not merely disabled in grafana 12, it
# is removed - which means this cannot silently regress: reintroduce an angular
# panel and it fails loudly at load rather than rendering an empty box.
#
# pin to the patch level so a rebuild months from now produces the same thing.
FROM grafana/grafana:12.3.0

# ------------------------------------------------------------------------
# plugins
# ------------------------------------------------------------------------
#
# deliberately none.
#
# this image used to install four panel plugins:
#
#   natel-discrete-panel          AngularJS - the old machine state timeline.
#                                 replaced by the built-in `state-timeline`,
#                                 which does the same job natively and is what
#                                 fleet.json and machine.json now use.
#   natel-plotly-panel            AngularJS - only ever used by the unprovisioned
#                                 dashboards-old/paths.json.
#   michaeldmoore-scatter-panel   same - unprovisioned only.
#   dalvany-image-panel           referenced by no dashboard in this repo.
#
# none are referenced by anything grafana actually provisions, and the two
# angular ones would refuse to initialise on 12.x anyway. dropping them makes
# this a plain grafana image - the build is faster, there is no external
# download at build time, and there is no unmaintained third-party javascript
# in the container.
#
# if you genuinely need a plugin later, add it back here with a pinned version
# and check first that it is not angular:
#   grafana-cli --pluginsDir "${GF_PATHS_PLUGINS}" plugins install <id>
USER root
ENV GF_PATHS_PLUGINS /data/grafana/plugins
RUN mkdir -p "${GF_PATHS_PLUGINS}"
USER grafana
