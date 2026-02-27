FROM node:20-slim

WORKDIR /srv/clawbrain

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm ci && npm run build && npm prune --omit=dev

COPY config ./config
COPY scripts ./scripts
COPY skills ./skills

ENV NODE_ENV=production
ENV CLAWBRAIN_API_HOST=0.0.0.0
ENV CLAWBRAIN_API_PORT=8000

EXPOSE 8000

CMD ["node", "dist/server.js"]
