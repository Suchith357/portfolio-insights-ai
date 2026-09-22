# PortfolioIQ backend API (Express + Prisma + PostgreSQL).
#
# AI note: this image does NOT bundle Ollama or the Qwen models. The AI module
# degrades gracefully to UNAVAILABLE when Ollama is unreachable — point
# AI_OLLAMA_BASE_URL at a host-running Ollama (or an ollama container) to
# enable local inference. See docs/AI_RAG_FOUNDATION.md.
FROM node:22-bookworm-slim

WORKDIR /app

# libstdc++ is present in the base image; python3/build-essential are needed
# only if faiss-node has no prebuilt binary for the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci

# Prisma client + schema.
COPY prisma ./prisma
RUN npx prisma generate

# Application source.
COPY src ./src
COPY tsconfig.json ./
COPY scripts ./scripts

# Compile TypeScript to dist/ (tsc output lands in dist/src/...).
# devDependencies (typescript, tsx) are kept so `npm run db:seed` and the
# SQL migration runner remain usable inside the container.
RUN npm run build

EXPOSE 4000

# Start the compiled server. `npm run db:seed` is idempotent and only creates
# the two demo accounts if missing — it never deletes existing data.
CMD ["sh", "-c", "node dist/src/server.js"]
