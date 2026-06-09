FROM node:20-alpine

WORKDIR /app

# Instala dependencias primeiro (cache de layers)
COPY package*.json ./
RUN npm ci --only=production

# Copia o restante do codigo
COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
