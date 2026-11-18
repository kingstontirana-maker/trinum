FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data COOKIE_SECURE=1
COPY package.json ./
COPY scripts/fetch-vendor.js ./scripts/
RUN node scripts/fetch-vendor.js
COPY server.js index.html app.js voice.js voice-fx.js video-fx.js call.js style.css platform.css admin.html admin.js admin.css ./
COPY assets ./assets
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
