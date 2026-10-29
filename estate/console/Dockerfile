# The console has no dependencies: node:alpine and two files copied in.
# Copying the directory (not just the .js) keeps public/index.html beside it,
# which is how the server finds the page it serves.
FROM node:24-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production
USER node
EXPOSE 8080

CMD ["node", "server.js"]
