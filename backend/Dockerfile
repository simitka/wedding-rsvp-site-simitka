FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data

# libvips для конвертации фото гостей в PNG (любой формат, включая HEIC с айфонов):
# vips-tools даёт vipsthumbnail, vips-heif — делегат HEIC/HEIF. Ставим как root
# до «USER node».
RUN apk add --no-cache vips-tools vips-heif

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
VOLUME /data

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

CMD ["node", "src/server.js"]
