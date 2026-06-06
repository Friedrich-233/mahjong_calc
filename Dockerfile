# syntax=docker/dockerfile:1

# ─── Build stage ─────────────────────────────────────────────────────────────
# Compiles the Rust→wasm decomposer and bundles the frontend into dist/.
# Uses the full node:bookworm image (has curl, git, build-essential) so we can
# install the Rust toolchain. Everything here is discarded in the final image.
FROM node:22-bookworm AS builder
ENV HUSKY=0
WORKDIR /app

# Rust toolchain + wasm-pack (the decomposer is built from Rust at build time;
# its compiled pkg/ is not committed to the repo).
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add wasm32-unknown-unknown \
 && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# 1. Build the wasm package first — npm's `decomposer` is `file:./wasm/decomposer/pkg`.
COPY wasm ./wasm
RUN cd wasm/decomposer && wasm-pack build

# 2. Install node dependencies (the wasm pkg now exists for the file: dependency).
COPY package.json package-lock.json ./
RUN npm ci

# 3. Copy the rest of the source and produce the production build in dist/.
ARG COMMIT_HASH=docker
ENV COMMIT_HASH=${COMMIT_HASH}
COPY . .
RUN npm run build

# ─── Runtime stage ───────────────────────────────────────────────────────────
# Small image that only runs the Express server. It serves the static dist/ and
# handles /api/* — it does NOT need the frontend build toolchain.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

# Install only the backend's runtime deps (express, openai, tsx).
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Backend source + the built frontend.
COPY server/ ./
COPY --from=builder /app/dist /app/dist

# The container always listens on 5173; publish it to a host port via compose.
ENV PORT=5173
EXPOSE 5173
CMD ["npm", "start"]
