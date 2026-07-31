FROM node:22-bookworm-slim

WORKDIR /app

# The cloud hub reuses the same verified operating-data parser as the desktop
# application, so production dependencies are installed at repository root.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY shared ./shared
COPY cloud-data-hub ./cloud-data-hub

WORKDIR /app/cloud-data-hub
ENV NODE_ENV=production
ENV PORT=4328
ENV CLOUD_HUB_DATA_DIR=/data

EXPOSE 4328
CMD ["node", "server.js"]

