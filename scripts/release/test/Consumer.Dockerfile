ARG BASE
FROM ${BASE}
COPY scripts/release/consumer-tools.json /opt/consumer-tools.json
COPY scripts/release/consumer-runtime/provision.mjs /opt/provision.mjs
RUN env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/bootstrap node /opt/provision.mjs
RUN rm -rf /tmp/bootstrap /tmp/npm.tgz /opt/provision.mjs
WORKDIR /consumer
ENV HOME=/home/consumer
