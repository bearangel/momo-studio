FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
RUN npm install --save-dev typescript @types/node @types/ws && npm run build
EXPOSE 8080
CMD ["node", "dist/server.js"]