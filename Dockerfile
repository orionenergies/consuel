# L'image Playwright embarque Chromium et ses dépendances système.
# La version doit rester identique à celle de "playwright" dans package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HEADLESS=true \
    SCREENSHOT_DIR=/tmp/screenshots
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER pwuser
EXPOSE 8080
CMD ["node", "dist/server.js"]
