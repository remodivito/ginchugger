# SPDX-License-Identifier: GPL-3.0-or-later
# The GinChugger team server (product v2 spec 3.2, 9.1): one container, one data folder (/data), one settings
# file (/data/settings.json, written with every key on first start). It holds the shared record and runs no model:
# no AI credential, no model CLI and no executor code is in this image (PR-TEAM-01, PR-SEC-07).
#   docker build -t ginchugger-legal-server:<version> .
#   docker compose up -d        (compose.yml: port 8443, the data volume, IT's certificate)
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production GCL_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Only what the server and gcl run: the record (playbooks, members), its routes, the settings, the store client (Docker
# is not available inside this container: compose.yml runs Paperless beside it and sets the store to external; its
# store-init service runs server/store/compose-init.js from this image), the shared playbooks and clause types.
COPY server/ ./server/
COPY shared/ ./shared/
COPY bin/ ./bin/
COPY data/clause-types.json data/playbook.json ./data/
COPY data/playbooks/ ./data/playbooks/
RUN rm -f server/executors.js server/review.js server/tools-listener.js server/tool-smoke.js server/index.js server/local-routes.js server/team-client.js \
 && chmod +x bin/gcl.js server/team-server.js && ln -s /app/bin/gcl.js /usr/local/bin/gcl \
 && mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 8443
# Liveness only: the certificate is IT's, so this probe does not check it; the lawyers' apps always do.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "require('https').get({host:'127.0.0.1',port:8443,path:'/api/v2/server-info',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server/team-server.js"]
