FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
RUN npm init -y && npm install --omit=dev --ignore-scripts --save-exact playwright@1.58.2
COPY --chown=pwuser:pwuser server.mjs browser.mjs ./
USER pwuser
EXPOSE 3003
CMD ["node", "server.mjs"]
