# dockerfile to build grafana image with plugins included.
# see services/docker-compose.yaml grafana section for more info.

# ------------------------------------------------------------------------
# base image
# ------------------------------------------------------------------------
#
# was grafana/grafana:8.2.2 (october 2021), held back by this note:
#
#   can't upgrade beyond 8.3.5 yet - get 'Origin not allowed' error on dash,
#   due to running through traefik and teleport? how fix?
#   see https://github.com/grafana/grafana/issues/45117
#
# that was a CSRF origin check added in 8.3.x biting setups behind a reverse
# proxy. it is configuration, not a ceiling: grafana honours `root_url` and
# `[security] csrf_trusted_origins` for exactly this. the example setup does not
# run behind traefik at all, so it never applied here - see the note in
# setups/example/volumes/grafana/etc/grafana.ini if you put one in front.
#
# staying on 8.2.2 was the worse trade. it predates the fix for
# CVE-2021-43798, an unauthenticated path traversal that reads arbitrary files
# off the grafana container, patched in 8.3.1/8.2.7 - and .env-example publishes
# grafana on port 80.
#
# 10.4.19 is the last 10.4 patch. it is chosen over 11.x deliberately: this
# setup's dashboards use natel-discrete-panel and the old `graph` panel, both
# AngularJS. grafana 11 turned angular off by default and 12 removed it
# outright, so 11+ silently breaks the main dashboard's timeline. 10.4 still
# supports angular (see grafana.ini) while carrying two and a half years of
# fixes. treat it as a staging post: the angular panels want replacing with
# react equivalents before the next jump.
FROM grafana/grafana:10.4.19

# add plugins
# also try philipsgis-phlowchart-panel
#
# note: natel-discrete-panel, natel-plotly-panel and michaeldmoore-scatter-panel
# are all AngularJS plugins and receive no further updates. they install and run
# on 10.4, and are the reason this image is not on 11.x.
USER root
ENV GF_PATHS_PLUGINS /data/grafana/plugins
RUN mkdir -p "${GF_PATHS_PLUGINS}"
RUN grafana-cli --pluginsDir "${GF_PATHS_PLUGINS}" plugins install natel-discrete-panel && \
  grafana-cli --pluginsDir "${GF_PATHS_PLUGINS}" plugins install natel-plotly-panel && \
  grafana-cli --pluginsDir "${GF_PATHS_PLUGINS}" plugins install michaeldmoore-scatter-panel && \
  grafana-cli --pluginsDir "${GF_PATHS_PLUGINS}" plugins install dalvany-image-panel
USER grafana
