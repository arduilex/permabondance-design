FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dépendances
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Code
COPY . .

# Dossier des images (le volume monté héritera de cette propriété à la 1re création)
RUN mkdir -p /data/uploads && chown -R node:node /app /data

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
