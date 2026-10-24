FROM node:20-alpine

WORKDIR /app

# Copy package definition and files
COPY package.json ./
COPY bin ./bin
COPY src ./src

# Create freeseek config directory
RUN mkdir -p /root/.freeseek

ENV PORT=8787
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 8787

CMD ["node", "bin/freeseek.js"]
