FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/formtech.sqlite
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
CMD ["node", "server.js"]
