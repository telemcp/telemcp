# telemcp: self-hosted Telegram MCP server
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY contract ./contract
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL io.modelcontextprotocol.server.name="io.github.telemcp/telemcp"
LABEL org.opencontainers.image.source="https://github.com/telemcp/telemcp"
LABEL org.opencontainers.image.description="Self-hosted Telegram MCP server"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    TELEMCP_HOME=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contract ./contract
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]
