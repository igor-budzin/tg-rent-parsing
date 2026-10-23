# Node 24 is the current LTS line (security fixes until 2028-04); 20 reached end-of-life on 2026-04-30
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime image: compiled code and production dependencies only, no TypeScript toolchain
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The app needs no write access to its own files; run without root
USER node

CMD ["node", "dist/index.js"]
