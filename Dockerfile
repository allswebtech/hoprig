# hoprig as a hub: it shows and relays your other computers. No Claude Code and no terminal run in it, so the
# image needs no build tools (the terminal module, node-pty, is optional and left out). See docs/HUB.md.
FROM node:24.22.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY skills ./skills
COPY LICENSE NOTICE TRADEMARKS.md ./
RUN mkdir /data && chown node:node /data
USER node
# Settings, the password file and state live in /data: mount a volume there so they survive a new image.
ENV HOPRIG_HUB=1 HOPRIG_CONFIG_DIR=/data/config HOPRIG_STATE_DIR=/data/state HOST=0.0.0.0 PORT=7433
VOLUME /data
EXPOSE 7433
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/hoprig.mjs", "serve", "--password-file", "/data/dashboard-password.txt"]
