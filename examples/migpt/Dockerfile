FROM node:22-bookworm AS builder

WORKDIR /app

# 工具链与依赖清单放在源码 COPY 之前。这样修改 TypeScript/Web 页面后，
# Docker 不会重新下载整套 Ubuntu、Rust、Node 和 npm 依赖，也不会不断堆积
# 数 GB 的中间层导致构建失败但旧容器继续运行。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

COPY examples/migpt/package.json examples/migpt/pnpm-lock.yaml ./
COPY examples/migpt/Cargo.toml examples/migpt/Cargo.lock ./
COPY packages/client-rust/Cargo.toml packages/client-rust/Cargo.lock ./client-rust/
RUN corepack enable \
    && corepack install \
    && pnpm install --frozen-lockfile

COPY examples/migpt .
COPY packages/client-rust ./client-rust

# 容器构建上下文中 client-rust 位于 /app/client-rust。
RUN sed -i 's|../../packages/||g' Cargo.toml \
    && pnpm build


FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV MIGPT_WORKDIR=/data
ENV MIGPT_PORT=4398
VOLUME ["/data"]

COPY --from=builder /app/migpt /app/migpt
COPY --from=builder /app/web /app/web
COPY --from=builder /app/config.ts /app/config.ts
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/tsconfig.json /app/tsconfig.json
COPY --from=builder /app/node_modules /app/node_modules

CMD ["npm", "run", "start"]
