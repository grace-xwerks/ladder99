# docker image build instructions
#
# l99 build adapter
#
# keep in synch with all Dockerfiles - adapter, meter, recorder, relay, simulator.
#
# see https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/

# ------------------------------------------------------------------------
# base image
# ------------------------------------------------------------------------
#
# this used to be `FROM ubuntu:22.10`, chosen in 2022 because 22.04 LTS only
# packaged node v12 while 22.10 had v18. that traded an LTS base for a newer
# node and lost: ubuntu 22.10 (kinetic) went EOL in july 2023 and its archives
# moved to old-releases.ubuntu.com, so `apt-get update` returned 404 for every
# repository and the build died on `Unable to locate package nodejs`.
#
# the node images solve the original problem directly - node is already there,
# at a version we pin, on a debian base that is still supported. the -bookworm
# build stage ships python3 and build-essential, which the native modules
# (usb, node-hid) need; the -bookworm-slim runtime stage does not carry them.
#
# pin to the patch level so a rebuild six months from now produces the same
# thing. bump deliberately, not by drifting on a floating tag.
ARG NODE_VERSION=22.23.2

# ------------------------------------------------------------------------
# first stage - build dependencies
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm AS build

# prevent apt install getting stuck on timezone info
ENV DEBIAN_FRONTEND=noninteractive

# headers needed to compile the usb and node-hid modules, which the dymo scale
# driver uses. without them node-gyp fails with 'libudev.h: No such file or
# directory'. see https://github.com/node-hid/node-hid#compiling-from-source
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    libudev-dev \
    libusb-1.0-0-dev \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

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
RUN npm config set fetch-retry-maxtimeout 120000 \
  && npm install --package-lock-only --omit=dev \
  && npm clean-install --audit=false --omit=dev

# ------------------------------------------------------------------------
# second stage - runtime
# ------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production

# runtime shared libraries for the native modules built above, plus ping and
# route - worth the few hundred kb, because the first question about an adapter
# that cannot reach a control is always whether the container can see it.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    libusb-1.0-0 \
    libudev1 \
    iputils-ping \
    net-tools \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/app

# package.json is needed at runtime so node honours "type": "module"
COPY package.json /usr/app/package.json
COPY --from=build /usr/app/node_modules /usr/app/node_modules
COPY src /usr/app/src

#. runs as root - the adapter writes cookie files into a mounted volume that is
#  already owned by root, so USER node fails on read/write. fix the volume
#  ownership and this can drop privileges like relay/meter/recorder do.

# note: When you run an image that uses the exec form (ie an array),
# Docker will run the command as is, without a wrapper process.
# Your Node.js application will be the first and only running process with PID 1.
# be sure to run it with --init flag, so can ctrl-c out of it.
ENTRYPOINT ["node", "/usr/app/src/index.js"]
