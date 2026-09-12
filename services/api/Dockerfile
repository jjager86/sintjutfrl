FROM node:22-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
