# Open-XiaoAI x MiGPT-Next

[Open-XiaoAI](https://github.com/idootop/open-xiaoai) 的 Node.js 版 Server 端，用来演示小爱音箱接入[MiGPT](https://github.com/idootop/mi-gpt)（完美版）。

相比原版的 `MiGPT` 和 `MiGPT-Next` 项目，该版本可以完美打断小爱音箱的回复，响应延迟更低，效果更完美 👍

## 快速开始

> [!NOTE]
> 继续下面的操作之前，你需要先在小爱音箱上启动运行 Rust 补丁程序 [👉 教程](../../packages/client-rust/README.md)

首先，克隆仓库代码到本地。

```shell
# 克隆代码
git clone https://github.com/idootop/open-xiaoai.git

# 进入当前项目根目录
cd examples/migpt
```

业务配置不写入镜像，也不通过环境变量下发。服务启动后打开管理页面，在“配置”中填写
OpenAI Base URL、模型、API Key、PodSuite 地址、集成 Token 和管理 Token，点击保存后会写入
挂载目录 `/data/config.json`。只有系统提示词允许通过 `MIGPT_SYSTEM_PROMPT` 提供默认值。
从旧版本升级时，首次启动会清理旧版写入的 OpenAI/PodSuite 业务配置，需要在页面重新填写；
已有管理 Token、设备列表和系统提示词会保留。

### Docker 运行

[![Docker Image Version](https://img.shields.io/docker/v/alanoo/migpt?color=%23086DCD&label=docker%20image)](https://hub.docker.com/r/alanoo/migpt)

推荐使用以下命令，直接 Docker 一键运行。

```shell
docker compose up -d
```

也可以手工运行镜像：

```shell
docker run -it --rm \
  -p 4399:4399 -p 4398:4398 \
  -v migpt-data:/data \
  alanoo/migpt:latest
```

启动后打开 `http://音箱所在主机:4398/`，可以登记音箱、查看连接状态、修改模型和系统提示词、
查看对话、控制播放及设置定时停止。PodSuite 与 MiGPT 的集成 Token 需要在 PodSuite 服务端
和 MiGPT 管理页面中设置为同一个值；未设置 Token 时仅建议在可信内网使用。当前一个 MiGPT 进程只
维护一个活动音箱连接；“音箱”页面的登记用于标识和状态展示，不会自动 SSH 刷机或部署客户端。

系统提示词默认是“你是一个智能助手，请根据用户的问题给出回答。”。OpenAI 和 PodSuite
配置为空时服务仍可启动，但相应的大模型回答或播客功能需要先在管理页面配置。系统提示词
也可以在管理页面“配置”中改为空或自定义内容。

语音示例：

* “播放播客剑来”——没有未完成记录时会询问季和集；
* “第3季第4集”——选择并开始播放；
* “暂停播客 / 继续播放 / 停止播客 / 播放下一集”；
* “30分钟后停止播放 / 取消定时停止”。

播放暂停或停止时，MiGPT 会向 PodSuite 上报毫秒级进度，下一次只说节目名即可续播。

### 编译运行

> [!TIP]
> 如果你是一名开发者，想要修改源代码实现自己想要的功能，可以按照下面的步骤，自行编译运行该项目。

为了能够正常编译运行该项目，你需要安装以下依赖环境：

- Node.js v22.x: https://nodejs.org/zh-cn/download
- Rust: https://www.rust-lang.org/learn/get-started

准备好开发环境后，按以下步骤即可正常启动该项目。

```bash
# 启用 PNPM 包管理工具
corepack enable && corepack install

# 安装依赖
pnpm install

# 编译运行
pnpm dev
```

## 注意事项

1. 默认 Server 服务端口为 `4399`（比如 ws://192.168.31.227:4399），可用 `MIGPT_WS_PORT` 修改；运行前请确保该端口未被其他程序占用。

2. 管理 HTTP API 默认端口为 `4398`，数据目录为 `/data`（包含配置、设备和对话记录）。

3. OH2P 使用独占麦克风仲裁：MiGPT 连接后会启用固件内置的 `/data/pns.lab` 实验模式，
   让小米云只返回 ASR 而不自动执行 NLP/TTS。播客指令由 MiGPT 处理；其他音乐、天气和设备控制
   由 MiGPT 通过 `ai_service` 显式转交一次给原生小爱，因此不会抢麦或重复执行。可设置
   `MIGPT_EXCLUSIVE_MIC=0` 关闭（不推荐）。MiGPT 创建的实验模式文件带有专用标记，音箱客户端
   与服务端断开时会自动删除它并恢复原生小爱，不会删除用户自己已有的 `/data/pns.lab`。

4. 默认 Rust Server 在启动时，并没有开启小爱音箱的录音能力。
   如果你需要在 Node.js 端正常接收音频输入流，或者播放音频输出流，请将 `src/server.rs` 文件中被注释掉的 `start_recording` 和 `start_play` 代码加回来，然后重新编译运行。

5. 如果音箱上原本已有用户自定义的 `/data/pns.lab`，MiGPT 不会覆盖它，而是自动退回到每条
   指令先中断原生小爱的兼容模式；只有 MiGPT 自己创建的标记文件才会在断开时清理。

6. 本仓库本次修改了 Client 断开清理逻辑。若音箱仍在使用旧版 `/data/open-xiaoai/client`，
   请按 `packages/client-rust/README.md` 重新交叉编译并覆盖；本机已验证可用命令为
   `cross build --release --target armv7-unknown-linux-gnueabihf`，生成文件位于
   `packages/client-rust/target/armv7-unknown-linux-gnueabihf/release/client`。
   覆盖后还必须重启音箱上的 Client 进程；仅执行 `dd` 不会让已运行的进程加载新代码。

> [!NOTE]
> 本项目只是一个简单的演示程序，抛砖引玉。如果你想要更多的功能，比如唤醒词识别、语音转文字、连续对话等（甚至是对接 OpenAI 的 [Realtime API](https://platform.openai.com/docs/guides/realtime)），可参考本项目代码自行实现。
