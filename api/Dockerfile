FROM node:24-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY api ./api
RUN chmod +x /app/api/entrypoint.sh && mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/api/entrypoint.sh"]
CMD ["npm", "run", "start", "-w", "api"]
