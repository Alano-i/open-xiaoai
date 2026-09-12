#!/usr/bin/env bash
# 将本地已构建的 OH2P 原版和补丁固件发布到 GitHub Release。

set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PATCH_DIR="$ROOT_DIR/packages/client-patch"
ASSETS_DIR="$PATCH_DIR/assets"

die() {
    echo "❌ $*" >&2
    exit 1
}

command -v gh >/dev/null 2>&1 || die "未找到 GitHub CLI（gh），请先安装并登录"
gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录，请先执行 gh auth login"
[[ -f "$ASSETS_DIR/.model" && -f "$ASSETS_DIR/.version" ]] || die "请先执行 make img 构建固件"

MODEL=$(tr -d '\r\n' < "$ASSETS_DIR/.model")
VERSION=$(tr -d '\r\n' < "$ASSETS_DIR/.version")
[[ "$MODEL" == "OH2P" ]] || die "检测到型号 $MODEL，本目标只发布 OH2P 固件"
[[ -n "$VERSION" ]] || die "固件版本为空"

FIRMWARE_DIR=$(find "$ASSETS_DIR" -mindepth 2 -maxdepth 2 -type f -name root-patched.squashfs -print | sort | tail -n 1 | xargs -r dirname)
[[ -n "$FIRMWARE_DIR" ]] || die "找不到 root-patched.squashfs，请先执行 make img"
[[ -f "$FIRMWARE_DIR/root.squashfs" ]] || die "找不到原版 root.squashfs"

ORIGINAL="$ASSETS_DIR/OH2P_${VERSION}.squashfs"
PATCHED="$ASSETS_DIR/OH2P_${VERSION}_patched.squashfs"
cp "$FIRMWARE_DIR/root.squashfs" "$ORIGINAL"
cp "$FIRMWARE_DIR/root-patched.squashfs" "$PATCHED"

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
[[ -n "$REPO" ]] || die "无法确定 GitHub 仓库，请设置 GH_REPO（例如 Alano-i/open-xiaoai）"
TAG="OH2P_${VERSION}"
TITLE="Xiaomi 智能音箱 Pro（OH2P）v${VERSION}"
NOTES="OH2P v${VERSION} 补丁固件。下载 *_patched.squashfs 刷入，下载 *.squashfs 可刷回原版。"

echo "📦 正在发布 $REPO 的 $TAG Release..."
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" "$ORIGINAL" "$PATCHED" --repo "$REPO" --clobber
    gh release edit "$TAG" --repo "$REPO" --title "$TITLE" --notes "$NOTES" --latest
else
    gh release create "$TAG" "$ORIGINAL" "$PATCHED" \
        --repo "$REPO" \
        --title "$TITLE" \
        --notes "$NOTES" \
        --latest
fi

echo "✅ OH2P 固件发布完成：https://github.com/$REPO/releases/tag/$TAG"
