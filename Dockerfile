FROM nginx:alpine

# Имя контейнера RSVP API в docker-сети; в Dokploy перекрывается env-переменной
# приложения (appName бэкенда), в docker-compose — сервис `api`.
ENV RSVP_API_HOST=api

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
COPY index.en.html /usr/share/nginx/html/index.en.html
COPY favicon.ico /usr/share/nginx/html/favicon.ico
COPY assets/ /usr/share/nginx/html/assets/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1

EXPOSE 80
