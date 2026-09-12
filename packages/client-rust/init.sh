#!/bin/sh

cat << 'EOF'

▄▖      ▖▖▘    ▄▖▄▖
▌▌▛▌█▌▛▌▚▘▌▀▌▛▌▌▌▐ 
▙▌▙▌▙▖▌▌▌▌▌█▌▙▌▛▌▟▖
  ▌                 

v1.0.0  by: https://del.wang

EOF

set -e


# Client 二进制由本项目的 GitHub Actions 发布到 client-latest Release。
DOWNLOAD_BASE_URL="https://github.com/Alano-i/open-xiaoai/releases/download/client-latest"


WORK_DIR="/data/open-xiaoai"
CLIENT_BIN="$WORK_DIR/client"
SERVER_ADDRESS="ws://127.0.0.1:4399" # 默认不会连接到任何 server

restore_native_assistant() {
    if [ -f /data/pns.lab ] && grep -qxF '# managed by open-xiaoai MiGPT' /data/pns.lab; then
        rm -f /data/pns.lab
        /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1
    fi
}

if [ ! -d "$WORK_DIR" ]; then
    mkdir -p "$WORK_DIR"
fi

if [ ! -f "$CLIENT_BIN" ]; then
    echo "🔥 正在下载 Client 端补丁程序..."
    curl -L -# -o "$CLIENT_BIN" "$DOWNLOAD_BASE_URL/client"
    chmod +x "$CLIENT_BIN"
    echo "✅ Client 端补丁程序下载完毕"
fi


if [ -f "$WORK_DIR/server.txt" ]; then
    SERVER_ADDRESS=$(cat "$WORK_DIR/server.txt")
fi

echo "🔥 正在启动 Client 端补丁程序..."
# 启动并守护 Client。BusyBox 没有 nohup，使用后台进程 + wait，避免
# 手工替换二进制后 PID 文件指向旧进程。
while true; do
    # ps 的命令行可能被 BusyBox 截断，不能按包含路径的文本杀进程：
    # SSH 的 ash -c 也可能匹配。只处理 argv[0] 完全一致的 Client。
    for PID in $(pidof client 2>/dev/null || true); do
        EXECUTABLE="$(tr '\000' '\n' < "/proc/$PID/cmdline" 2>/dev/null | head -n 1)"
        if [ "$EXECUTABLE" = "$CLIENT_BIN" ]; then
            kill "$PID" >/dev/null 2>&1 || true
        fi
    done
    sleep 1

    echo "[$(date)] 启动 Client: $CLIENT_BIN $SERVER_ADDRESS" >> "$WORK_DIR/client.log"
    echo "[$(date)] SHA256: $(sha256sum "$CLIENT_BIN")" >> "$WORK_DIR/client.log"
    "$CLIENT_BIN" "$SERVER_ADDRESS" >> "$WORK_DIR/client.log" 2>&1 &
    CLIENT_PID="$!"
    echo "$CLIENT_PID" > "$WORK_DIR/client.pid"
    wait "$CLIENT_PID" || true
    echo "[$(date)] Client 已退出，1 秒后重启" >> "$WORK_DIR/client.log"
    sleep 1
done
