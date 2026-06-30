# Container image for the hosted InstantML MCP server (tools/mcp-server.mjs).
#
# This is intentionally separate from the repo-root Dockerfile (which builds the
# Rust API). The MCP server is a small Node process whose only runtime dependency
# is @modelcontextprotocol/sdk, so we install just that — pinned to the exact
# version in the monorepo package.json — rather than the whole web dependency
# tree. Built and deployed by tools/deploy-mcp.mjs and .github/workflows/deploy-mcp.yml.

# ---- deps: install only the MCP server's single runtime dependency ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
# Pull @modelcontextprotocol/sdk at the version pinned in package.json so the
# image stays in sync with the repo without dragging in next/react/clerk.
RUN npm install --omit=dev --no-save --no-package-lock \
      "@modelcontextprotocol/sdk@$(node -p "require('./package.json').dependencies['@modelcontextprotocol/sdk']")"

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    INSTANTML_MCP_TRANSPORT=http \
    INSTANTML_MCP_HOST=0.0.0.0
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node tools/mcp-server.mjs tools/mcp-server-tools.mjs ./tools/
# Cloud Run injects PORT (default 8080); the server reads PORT / INSTANTML_MCP_PORT.
EXPOSE 8080
USER node
CMD ["node", "tools/mcp-server.mjs", "--transport", "http"]
