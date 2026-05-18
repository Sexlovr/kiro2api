FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p configs/kiro data

EXPOSE 7860

CMD ["node", "src/server.js"]
