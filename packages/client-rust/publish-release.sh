#!/usr/bin/env bash
# 编译 ARMv7 Client 并将可执行文件发布到 GitHub 的 client-latest Release。

set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CLIENT_DIR="$ROOT_DIR/packages/client-rust"
ENV_FILE="${ENV_FILE:-$CLIENT_DIR/.env}"
TARGET_FROM_ENV=""
if [[ -f "$ENV_FILE" ]]; then
    TARGET_FROM_ENV=$(sed -n 's/^TARGET=//p' "$ENV_FILE" | tail -n 1)
fi
TARGET="${TARGET:-${TARGET_FROM_ENV:-armv7-unknown-linux-gnueabihf}}"
CLIENT_BIN="$CLIENT_DIR/target/$TARGET/release/client"
RELEASE_TAG="${CLIENT_RELEASE_TAG:-client-latest}"

die() {
    echo "❌ $*" >&2
    exit 1
}

command -v cross >/dev/null 2>&1 || die "未找到 cross，请先安装 cross"
command -v gh >/dev/null 2>&1 || die "未找到 GitHub CLI（gh），请先安装并登录"
gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录，请先执行 gh auth login"

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
[[ -n "$REPO" ]] || die "无法确定 GitHub 仓库，请设置 GH_REPO（例如 Alano-i/open-xiaoai）"

echo "🔨 正在编译 Client（目标：$TARGET）..."
cross build --release --target "$TARGET" --manifest-path "$CLIENT_DIR/Cargo.toml"
[[ -x "$CLIENT_BIN" ]] || die "编译完成但找不到可执行文件：$CLIENT_BIN"

echo "📦 正在发布 $REPO 的 $RELEASE_TAG Release..."
if gh release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$RELEASE_TAG" "$CLIENT_BIN" --repo "$REPO" --clobber
else
    gh release create "$RELEASE_TAG" "$CLIENT_BIN" \
        --repo "$REPO" \
        --title "Open-XiaoAI Client 最新版" \
        --notes "本项目本地构建的 ARMv7 Client。" \
        --prerelease \
        --latest=false
fi

echo "✅ Client 发布完成：https://github.com/$REPO/releases/tag/$RELEASE_TAG"
