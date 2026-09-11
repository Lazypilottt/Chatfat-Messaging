FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# The whole src/ tree, not just the entry point — the old Dockerfile copied
# server.js alone and the image could not start.
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY test/ ./test/
COPY tools/ ./tools/

ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000

# Global fetch (Node 18+), so the image needs no curl.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly — the shutdown
# handler then closes every socket with 1001 before exiting.
CMD ["node", "server.js"]
