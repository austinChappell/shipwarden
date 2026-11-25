# The ShipWarden push relay. It has no dependencies and keeps no files.
FROM node:24-alpine
WORKDIR /relay
COPY package.json ./
COPY src/relay.ts src/server.ts ./src/
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
