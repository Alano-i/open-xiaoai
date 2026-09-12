#!/usr/bin/env bash
# 使用当前仓库代码构建 Xiaomi 智能音箱 Pro（OH2P）补丁固件。

set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PATCH_DIR="$ROOT_DIR/packages/client-patch"
ASSETS_DIR="$PATCH_DIR/assets"
PATCHES_DIR="$PATCH_DIR/patches"
ENV_FILE="${ENV_FILE:-$PATCH_DIR/.env}"
IMAGE="${PATCH_IMAGE:-local/open-xiaoai-patch:latest}"
PLATFORM="${PATCH_PLATFORM:-linux/amd64}"

die() {
    echo "❌ $*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || die "未找到 Docker，请先安装 Docker"
[[ -f "$ENV_FILE" ]] || die "找不到配置文件：$ENV_FILE，请先复制 .env.example 并填写小米账号信息"
mkdir -p "$ASSETS_DIR" "$PATCHES_DIR"

echo "🐳 正在构建固件工具镜像：${IMAGE}（平台：${PLATFORM}）..."
docker build --platform "$PLATFORM" -t "$IMAGE" -f "$PATCH_DIR/Dockerfile" "$PATCH_DIR"

echo "🔥 正在构建 OH2P 补丁固件..."
docker run --rm \
    --platform "$PLATFORM" \
    --env-file "$ENV_FILE" \
    -v "$ASSETS_DIR:/app/assets" \
    -v "$PATCHES_DIR:/app/patches" \
    "$IMAGE"

[[ -f "$ASSETS_DIR/.model" && -f "$ASSETS_DIR/.version" ]] || die "构建完成但未找到 assets/.model 或 assets/.version"
MODEL=$(tr -d '\r\n' < "$ASSETS_DIR/.model")
VERSION=$(tr -d '\r\n' < "$ASSETS_DIR/.version")
[[ "$MODEL" == "OH2P" ]] || die "检测到型号 $MODEL，本目标只允许构建 OH2P 固件"
[[ -n "$VERSION" ]] || die "固件版本为空"

FIRMWARE_PATH=$(find "$ASSETS_DIR" -mindepth 2 -maxdepth 2 -type f -name root-patched.squashfs -print | sort | tail -n 1)
[[ -n "$FIRMWARE_PATH" ]] || die "找不到重新打包后的 OH2P 固件文件"
FIRMWARE_DIR=$(dirname "$FIRMWARE_PATH")
[[ -f "$FIRMWARE_DIR/root.squashfs" ]] || die "找不到重新打包后的 OH2P 固件文件"

echo "✅ OH2P 固件构建完成：${FIRMWARE_DIR}（版本：${VERSION}）"
