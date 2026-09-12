#!/usr/bin/env bash
# 小爱音箱 Client 一键安装/更新脚本：编译 ARMv7 Client，上传服务器地址，
# 并将最新 init.sh 安装到音箱的 /data/init.sh 后重启使其生效。

set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CLIENT_DIR="$ROOT_DIR/packages/client-rust"
INIT_SCRIPT="$CLIENT_DIR/init.sh"

# 默认从 packages/client-rust/.env 读取部署参数，便于直接执行 `make client`。
# .env 中的值会作为默认值；命令行显式传入的环境变量优先级更高。
ENV_FILE="${ENV_FILE:-$CLIENT_DIR/.env}"
if [[ -f "$ENV_FILE" ]]; then
    # 仅支持 KEY=VALUE 形式的简单 dotenv 文件，避免执行配置文件中的任意命令。
    while IFS= read -r env_line || [[ -n "$env_line" ]]; do
        env_line="${env_line#${env_line%%[![:space:]]*}}"
        [[ -z "$env_line" || "$env_line" == \#* ]] && continue
        if [[ "$env_line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            env_key="${BASH_REMATCH[1]}"
            env_value="${BASH_REMATCH[2]}"
            # 外部环境变量（例如 `BUILD=0 make client`）不被 .env 覆盖。
            if declare -p "$env_key" &>/dev/null; then
                continue
            fi
            if [[ "$env_value" == \"*\" && "$env_value" == *\" ]]; then
                env_value="${env_value:1:${#env_value}-2}"
            elif [[ "$env_value" == \'*\' && "$env_value" == *\' ]]; then
                env_value="${env_value:1:${#env_value}-2}"
            fi
            printf -v "$env_key" '%s' "$env_value"
            export "$env_key"
        fi
    done < "$ENV_FILE"
    echo "📄 已加载部署配置：$ENV_FILE"
fi

TARGET="${TARGET:-armv7-unknown-linux-gnueabihf}"
CLIENT_BIN="$CLIENT_DIR/target/$TARGET/release/client"
SPEAKER_HOST="${SPEAKER_HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SERVER_URL="${SERVER_URL:-}"
BUILD="${BUILD:-1}"
REBOOT="${REBOOT:-1}"
SSH_PASSWORD="${SSH_PASSWORD:-}"

usage() {
    cat <<'EOF'
用法：
  SPEAKER_HOST=192.168.1.100 SERVER_URL=wss://mi.example.com ./deploy.sh

可选环境变量：
  SPEAKER_HOST  小爱音箱 IP（未设置时交互输入）
  SERVER_URL    MiGPT WebSocket 地址，必须是 ws:// 或 wss://（未设置时交互输入）
  SSH_USER      SSH 用户，默认 root
  SSH_PORT      SSH 端口，默认 22
  SSH_PASSWORD  SSH 密码；不设置时使用 SSH Key，或在交互终端中输入
  ENV_FILE      配置文件路径，默认 packages/client-rust/.env
  BUILD         是否执行 cross 编译，默认 1；使用已有二进制时设置为 0
  REBOOT        上传完成后是否重启音箱，默认 1；设置为 0 只上传不切换运行进程

说明：需要本机已安装 cross、Docker，以及使用密码登录时安装 sshpass。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

die() {
    echo "❌ $*" >&2
    exit 1
}

command -v bash >/dev/null 2>&1 || die "找不到 bash"
[[ -f "$INIT_SCRIPT" ]] || die "找不到启动脚本：$INIT_SCRIPT"

if [[ -z "$SPEAKER_HOST" ]]; then
    [[ -t 0 ]] || die "请通过 SPEAKER_HOST 指定音箱 IP"
    read -r -p "小爱音箱 IP：" SPEAKER_HOST
fi
[[ -n "$SPEAKER_HOST" ]] || die "音箱 IP 不能为空"

if [[ -z "$SERVER_URL" ]]; then
    [[ -t 0 ]] || die "请通过 SERVER_URL 指定 MiGPT WebSocket 地址"
    read -r -p "MiGPT WebSocket 地址（ws:// 或 wss://）：" SERVER_URL
fi
[[ "$SERVER_URL" =~ ^wss?://[^[:space:]]+$ ]] || die "SERVER_URL 必须是完整的 ws:// 或 wss:// 地址"

if [[ "$BUILD" != "0" ]]; then
    command -v cross >/dev/null 2>&1 || die "未找到 cross，请先安装 cross，或设置 BUILD=0 使用已有二进制"
    echo "🔨 正在编译 Client（目标：${TARGET}）..."
    cross build --release --target "$TARGET" --manifest-path "$CLIENT_DIR/Cargo.toml"
fi

[[ -x "$CLIENT_BIN" ]] || die "找不到可执行 Client：$CLIENT_BIN"

if [[ -z "$SSH_PASSWORD" && -t 0 ]]; then
    read -r -s -p "SSH 密码（留空表示使用 SSH Key）：" SSH_PASSWORD
    echo
fi

SSH_COMMON=(
    -o HostKeyAlgorithms=+ssh-rsa
    -o StrictHostKeyChecking=no
    -o ConnectTimeout=10
    -p "$SSH_PORT"
)
if [[ -n "$SSH_PASSWORD" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "设置了 SSH_PASSWORD，但未找到 sshpass；请安装 sshpass 或改用 SSH Key"
    export SSHPASS="$SSH_PASSWORD"
    SSH=(sshpass -e ssh "${SSH_COMMON[@]}" "${SSH_USER}@${SPEAKER_HOST}")
else
    SSH=(ssh "${SSH_COMMON[@]}" "${SSH_USER}@${SPEAKER_HOST}")
fi

run_remote() {
    "${SSH[@]}" "$@"
}

upload_stream() {
    local source="$1"
    local destination="$2"
    # 使用标准输入传输，避免 scp 在旧版 BusyBox 音箱上的兼容性问题。
    dd if="$source" bs=64k 2>/dev/null | run_remote "cat > '$destination'"
}

echo "🔌 正在连接音箱 $SSH_USER@$SPEAKER_HOST:$SSH_PORT ..."
run_remote "true" >/dev/null
run_remote "mkdir -p /data/open-xiaoai"
run_remote "if [ -f /data/open-xiaoai/client ]; then cp /data/open-xiaoai/client /data/open-xiaoai/client.previous; fi"

echo "⬆️ 正在上传 Client..."
upload_stream "$CLIENT_BIN" "/data/open-xiaoai/client.new"
run_remote "chmod +x /data/open-xiaoai/client.new && mv -f /data/open-xiaoai/client.new /data/open-xiaoai/client"

echo "📝 正在写入 MiGPT 地址：$SERVER_URL"
printf '%s\n' "$SERVER_URL" | run_remote "cat > /data/open-xiaoai/server.txt.new && mv -f /data/open-xiaoai/server.txt.new /data/open-xiaoai/server.txt"

# init.sh 必须最后安装到 /data，确保它与本次上传的 Client 一起更新。
echo "⬆️ 正在安装最新 init.sh 到 /data/init.sh..."
upload_stream "$INIT_SCRIPT" "/data/init.sh.new"
run_remote "chmod +x /data/init.sh.new && mv -f /data/init.sh.new /data/init.sh"

LOCAL_SHA=$(shasum -a 256 "$CLIENT_BIN" | awk '{print $1}')
REMOTE_INFO=$(run_remote "printf 'client_sha='; sha256sum /data/open-xiaoai/client | awk '{print \$1}'; printf 'server_url='; cat /data/open-xiaoai/server.txt; printf 'init_mode='; stat -c '%a' /data/init.sh 2>/dev/null || ls -l /data/init.sh")
echo "✅ 上传完成"
echo "本地 Client SHA256：$LOCAL_SHA"
echo "$REMOTE_INFO"

if [[ "$REBOOT" != "0" ]]; then
    echo "🔄 正在重启音箱，使新 Client 和 init.sh 生效..."
    run_remote "sync; reboot" >/dev/null 2>&1 || true
    echo "✅ 音箱已发起重启。等待网络恢复并验证..."

    for _ in {1..20}; do
        sleep 3
        if VERIFY_INFO=$(run_remote "printf 'client_sha='; sha256sum /data/open-xiaoai/client | awk '{print \$1}'; printf 'server_url='; cat /data/open-xiaoai/server.txt; ps | grep '/data/open-xiaoai/client' || true" 2>/dev/null); then
            echo "$VERIFY_INFO"
            if [[ "$VERIFY_INFO" == *"client_sha=$LOCAL_SHA"* ]]; then
                echo "✅ 已验证新 Client 正在音箱上运行"
                break
            fi
        fi
    done
else
    echo "ℹ️ REBOOT=0：文件已上传，但正在运行的旧进程尚未切换；请重启音箱后生效。"
fi
