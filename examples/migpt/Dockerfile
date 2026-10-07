# 精简版 ffmpeg：只编译倍速播放用到的功能（HTTP/HTTPS 拉流、常见播客音频解码、
# atempo 变速不变调、libmp3lame 编码 MP3），体积约为发行版 ffmpeg 的十分之一。
# 源码编译，amd64/arm64 多架构构建都适用。udp 协议不会被用到，但 FFmpeg 8 的
# OpenSSL TLS 模块（含 DTLS）链接时依赖它。
FROM debian:bookworm-slim AS ffmpeg

ARG FFMPEG_VERSION=8.0.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates xz-utils libmp3lame-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" | tar -xJ -C /tmp \
    && cd "/tmp/ffmpeg-${FFMPEG_VERSION}" \
    && ./configure \
        --prefix=/opt/ffmpeg \
        --disable-everything --disable-autodetect --disable-doc --disable-debug \
        --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale --disable-x86asm \
        --enable-small --enable-version3 \
        --enable-openssl --enable-libmp3lame \
        --enable-protocol=file,pipe,http,https,tcp,tls,udp \
        --enable-demuxer=mp3,aac,mov,ogg,flac,wav,matroska \
        --enable-parser=mpegaudio,aac,flac,vorbis,opus \
        --enable-decoder=mp3,mp3float,aac,aac_latm,alac,flac,vorbis,opus,pcm_s16le,pcm_s24le,pcm_f32le \
        --enable-filter=atempo,aresample,aformat,anull,atrim,abuffer,abuffersink \
        --enable-encoder=libmp3lame \
        --enable-muxer=mp3 \
    && make -j"$(nproc)" \
    && make install \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -version


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

# 精简版 ffmpeg 动态链接 libmp3lame 和 OpenSSL，运行时只需安装这两个库。
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmp3lame0 libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg

COPY --from=builder /app/migpt /app/migpt
COPY --from=builder /app/web /app/web
COPY --from=builder /app/config.ts /app/config.ts
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/tsconfig.json /app/tsconfig.json
COPY --from=builder /app/node_modules /app/node_modules

CMD ["npm", "run", "start"]
