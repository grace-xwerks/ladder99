# docker image build instructions
#
# l99 build simulator
#
# keep in synch with all Dockerfiles - adapter, meter, recorder, relay, simulator.

# ------------------------------------------------------------------------
# base image
# ------------------------------------------------------------------------
#
# was `FROM ubuntu:22.10` for the build stage and `FROM node:lts` for runtime.
# 22.10 (kinetic) is EOL and its archives returned 404, breaking apt; `node:lts`
# floated to whatever major was current on the day you built.
#
# the simulator has no native-usb dependencies - it is modbus, mqtt and opcua -
# so it does not need the ubuntu detour the adapter took. it does still build on
# the full -bookworm image, because node-opcua and modbus-serial pull optional
# native addons that want a compiler when no prebuild matches.
ARG NODE_VERSION=22.23.2

# ------------------------------------------------------------------------
# first stage - build dependencies
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm AS build

WORKDIR /usr/app
ENV NODE_ENV=production
COPY package.json /usr/app/

# see the adapter Dockerfile for why `npm audit fix` is not run in the build.
RUN npm config set fetch-retry-maxtimeout 120000 \
  && npm install --package-lock-only --omit=dev \
  && npm clean-install --audit=false --omit=dev

# ------------------------------------------------------------------------
# second stage - runtime
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /usr/app

# package.json is needed at runtime so node honours "type": "module"
COPY package.json /usr/app/package.json
COPY --from=build /usr/app/node_modules /usr/app/node_modules
COPY src /usr/app/src

USER node

# note: When you run an image that uses the exec form (ie an array),
# Docker will run the command as is, without a wrapper process.
# Your Node.js application will be the first and only running process with PID 1.
# be sure to run it with --init flag, so can ctrl-c out of it.
ENTRYPOINT ["node", "/usr/app/src/index.js"]
