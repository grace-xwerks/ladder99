# docker image build instructions
#
# l99 build meter
#
# keep in synch with all Dockerfiles - adapter, meter, recorder, relay, simulator.
#
# see https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/

# ------------------------------------------------------------------------
# base image
# ------------------------------------------------------------------------
#
# was `FROM node:lts-slim` on both stages. `lts` is a floating tag: it meant
# node 16 when this was written and moves to a new major every october, so the
# image you got depended on the day you built it rather than on the commit.
# an unpinned major is also how code written for one runtime quietly starts
# running on another.
#
# meter has no native dependencies, so -slim serves for both stages.
#
# pin to the patch level so a rebuild six months from now produces the same
# thing. bump deliberately, not by drifting on a floating tag.
ARG NODE_VERSION=22.23.2

# ------------------------------------------------------------------------
# first stage - build dependencies
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /usr/app
ENV NODE_ENV=production
COPY package.json /usr/app/

# install javascript dependencies.
#
# raise the fetch timeout from 30s to 2m for slow shop connections, generate a
# lockfile from package.json, then install deterministically from it.
#
# note: `npm audit fix` is deliberately NOT run here. it resolves differently
# depending on when you build, so two builds of the same commit could ship
# different dependency trees - and it is free to bump a major version, which is
# how a build starts failing without anyone changing a line. audit separately,
# in daylight, and commit the result.
#
# `--only=production` was also dropped: npm removed the flag in v9, and
# `--omit=dev` alongside it already does the job.
RUN npm config set fetch-retry-maxtimeout 120000   && npm install --package-lock-only --omit=dev   && npm clean-install --audit=false --omit=dev

# ------------------------------------------------------------------------
# second stage - runtime
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
USER node
WORKDIR /usr/app

# package.json is needed at runtime so node honours "type": "module"
COPY --chown=node:node package.json /usr/app/package.json
COPY --chown=node:node --from=build /usr/app/node_modules /usr/app/node_modules
COPY --chown=node:node src /usr/app/src

# note: When you run an image that uses the exec form (ie an array),
# Docker will run the command as is, without a wrapper process.
# Your Node.js application will be the first and only running process with PID 1.
# be sure to run it with --init flag, so can ctrl-c out of it.
ENTRYPOINT ["node", "/usr/app/src/index.js"]
