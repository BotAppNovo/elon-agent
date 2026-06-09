FROM node:20-alpine

# Dependencias de compilacao para better-sqlite3 (modulo nativo)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Instala dependencias primeiro (cache de layers)
COPY package*.json ./
RUN npm ci --only=production

# Copia o restante do codigo
COPY . .

# Diretorio persistente para o banco SQLite
# No Railway: configure um volume montado em /data
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/elon.db

EXPOSE 3000

CMD ["node", "index.js"]
