> [!WARNING]
> 本项目已停止维护，不再提供更新与支持，感谢大家的使用。

# Open-XiaoAI

让小爱音箱「听见你的声音」，解锁无限可能。

![](./docs/images/cover.jpg)

## 简介

2017 年，当全球首款千万级销量的智能音箱诞生时，我们以为触摸到了未来。但很快发现，这些设备被困在「指令-响应」的牢笼里：

- 它听得见分贝，却听不懂情感
- 它能执行命令，却不会主动思考
- 它有千万用户，却只有一套思维

我们曾幻想中的"贾维斯"级人工智能，在现实场景中沦为"天气预报+音乐播放器"。

**真正的智能不应被预设的代码逻辑所束缚，而应像生命体般在交互中进化。**

在上一个 [MiGPT](https://github.com/idootop/mi-gpt) 项目中，我们已经实现将 ChatGPT 接入到小爱音箱。

这一次 [Open-XiaoAI](https://github.com/idootop/open-xiaoai) 再次进化，直接接管小爱音箱的“耳朵”和“嘴巴”，

通过多模态大模型和 AI Agent，将小爱音箱的潜力完全释放，解锁无限可能。

**未来由你定义!**

## 你的声音 + 小爱音箱 = 无限可能

👉 [小爱音箱接入小智 AI 演示视频](https://www.bilibili.com/video/BV1TxJhzvEhz)

[![](./docs/images/xiaozhi.jpg)](https://www.bilibili.com/video/BV1TxJhzvEhz)

👉 [小爱音箱自定义唤醒词演示视频](https://www.bilibili.com/video/BV1YfVUz5EMj)

[![](./docs/images/kws.jpg)](https://www.bilibili.com/video/BV1YfVUz5EMj)

👉 [小爱音箱接入 MiGPT 演示视频](https://www.bilibili.com/video/BV1N1421y7qn)

[![](./docs/images/migpt.jpg)](https://www.bilibili.com/video/BV1N1421y7qn)

## 快速开始

> [!IMPORTANT]
> 本教程仅适用于 **小爱音箱 Pro（LX06）** 和 **Xiaomi 智能音箱 Pro（OH2P）** 这两款机型，**其他型号**的小爱音箱请勿直接使用！🚨

本项目由 Client 端 + Server 端两部分组成，你可以按照以下顺序运行该项目：

1. 刷机更新小爱音箱补丁固件，开启并 SSH 连接到小爱音箱 👉 [教程](docs/flash.md)
2. 在小爱音箱上安装运行 Client 端补丁程序 👉 [教程](packages/client-rust/README.md)
3. 运行以下演示程序，体验小爱音箱的全新能力 ✨
   - 👉 [小爱音箱接入小智 AI](examples/xiaozhi/README.md)
   - 👉 [小爱音箱自定义唤醒词](examples/kws/README.md)
   - 👉 [小爱音箱接入 MiGPT（完美版）](examples/migpt/README.md)
   - 👉 [小爱音箱接入 Gemini Live API](examples/gemini/README.md)
   - 👉 [小爱音箱组立体声（支持不同型号机型）](examples/stereo/README.md)

Client 更新也可以在项目根目录一键完成。脚本会交叉编译 ARMv7 Client、上传服务器地址，
并把最新的 `init.sh` 安装到音箱 `/data/init.sh`：

先复制 `packages/client-rust/.env.example` 为 `packages/client-rust/.env`，填写音箱地址、
MiGPT WebSocket 地址和 SSH 登录信息，然后执行：

```shell
make client
```

`.env` 已被 Git 忽略，不会提交密码等敏感信息；命令行环境变量可以覆盖 `.env` 中的同名配置。
未设置参数时脚本会交互询问；默认上传完成后重启音箱使新进程生效。

以上皆为抛砖引玉，你也可以亲手编写自己想要的功能，一切由你定义！

## Makefile 快捷命令

项目根目录的 `makefile` 提供 Client 部署和 MiGPT 镜像发布命令。执行前请先确认当前目录为
项目根目录：

```shell
cd /path/to/open-xiaoai
```

### `make client`：编译并安装小爱音箱 Client

该命令使用 `cross` 交叉编译 ARMv7 Client，然后通过 SSH 安装到小爱音箱，并完成以下操作：

1. 编译 `packages/client-rust` 的 release 版本；
2. 原子替换音箱上的 `/data/open-xiaoai/client`；
3. 写入 MiGPT WebSocket 地址到 `/data/open-xiaoai/server.txt`；
4. 将仓库最新的 `packages/client-rust/init.sh` 安装到音箱 `/data/init.sh`；
5. 默认重启音箱，并校验 Client 文件和运行进程。

首次使用时复制配置模板：

```shell
cp packages/client-rust/.env.example packages/client-rust/.env
```

编辑 `packages/client-rust/.env`：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SPEAKER_HOST` | 是 | 小爱音箱 IP 地址，例如 `192.168.1.100` |
| `SERVER_URL` | 是 | MiGPT 地址，必须是完整的 `ws://` 或 `wss://` URL |
| `SSH_USER` | 否 | SSH 用户名，默认 `root` |
| `SSH_PORT` | 否 | SSH 端口，默认 `22` |
| `SSH_PASSWORD` | 否 | SSH 密码；留空时使用 SSH Key 或交互输入 |
| `ENV_FILE` | 否 | 自定义配置文件路径，默认 `packages/client-rust/.env` |
| `TARGET` | 否 | Rust 编译目标，默认 `armv7-unknown-linux-gnueabihf` |
| `BUILD` | 否 | 是否执行交叉编译，默认 `1`；使用已有二进制时设为 `0` |
| `REBOOT` | 否 | 上传后是否重启音箱，默认 `1`；只上传不重启时设为 `0` |

然后执行：

```shell
make client
```

需要临时覆盖配置时，可以在命令行传入同名变量：

```shell
BUILD=0 REBOOT=0 make client
```

上例会使用已有的 ARMv7 二进制，只上传文件而不重启音箱。`packages/client-rust/.env` 已被
Git 忽略，请勿将 SSH 密码等敏感信息提交到仓库。

**依赖：** 已安装 Docker 和 [`cross`](https://github.com/cross-rs/cross)，并能通过 SSH 登录已
刷入补丁固件的小爱音箱。Apple Silicon 主机使用 `cross` 时，可能需要开启 Docker 的 Rosetta
兼容选项；更多刷机和手动安装步骤见 [`packages/client-rust/README.md`](packages/client-rust/README.md)。

### `make client-p`：构建并发布 Client

该命令只编译 ARMv7 Client 并更新 GitHub 的 `client-latest` Release，不会连接或重启音箱：

```shell
make client-p
```

需要先安装并登录 GitHub CLI：

```shell
gh auth login
```

如果仓库无法自动识别，可以指定：

```shell
GH_REPO=Alano-i/open-xiaoai make client-p
```

### `make img`：构建 OH2P 补丁固件

该命令使用当前仓库的 `packages/client-patch` 代码构建 Xiaomi 智能音箱 Pro（OH2P）固件，
需要先配置 `packages/client-patch/.env`（可复制 `.env.example`）。生成的原版和补丁固件位于
`packages/client-patch/assets`：

```shell
make img
```

命令会使用 Docker 构建本地固件工具镜像，并通过小米 OTA 接口下载当前设备固件。构建结束后
会校验型号必须为 `OH2P`，避免误把其他型号固件发布出去。

### `make img-push`：构建并发布 OH2P 固件

该命令等价于先执行 `make img`，再把两个固件上传到 `OH2P_<版本号>` GitHub Release：

```shell
make img-push
```

Release 中包含：

- `OH2P_<版本号>_patched.squashfs`：打补丁固件；
- `OH2P_<版本号>.squashfs`：原版固件，可用于刷回。

`make client-p` 和 `make img-push` 都需要 `gh auth login`，并且当前 GitHub 账号对仓库具有
Release 写权限。

### `make docker-migpt`：构建并推送 MiGPT 多架构镜像

该命令使用 Docker Buildx 构建 `examples/migpt/Dockerfile`，默认生成并推送：

```text
alanoo/migpt:latest
```

默认目标平台为 `linux/amd64,linux/arm64`，会自动创建或复用名为 `multiarch-builder` 的
Buildx 构建器，并推送多架构镜像清单。执行前先登录拥有推送权限的 Docker Hub 账号：

```shell
docker login
make docker-migpt
```

可以通过 Make 变量覆盖默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `IMAGE` | `alanoo/migpt:latest` | 推送的镜像名称和标签 |
| `PLATFORMS` | `linux/amd64,linux/arm64` | 要构建的平台列表 |
| `BUILDER` | `multiarch-builder` | Buildx 构建器名称 |
| `DOCKERFILE` | `examples/migpt/Dockerfile` | Dockerfile 路径 |
| `CONTEXT` | `.` | Docker 构建上下文 |

例如构建并推送自己的标签：

```shell
IMAGE=your-dockerhub-user/migpt:v1 \\
PLATFORMS=linux/amd64,linux/arm64 \\
make docker-migpt
```

`make docker-migpt` 只负责构建和推送镜像，不会自动修改正在运行的容器。部署到服务器时，
请在服务器上拉取新镜像并重新创建服务，例如：

```shell
docker compose pull migpt
docker compose up -d --force-recreate migpt
```

## GitHub Actions：发布 Client 和补丁固件

### 发布最新 Client

`.github/workflows/compile-client-rust.yml` 仅在包含 `packages/client-rust/**` 修改的 Pull Request
上运行，用于验证编译，不会因 `main` 分支推送自动构建，也不会发布 Release。正式发布请使用
`make client-p`。该工作流会：

1. 使用 `cross` 编译 `armv7-unknown-linux-gnueabihf` 版本；
2. 上传一个保留 7 天的临时构建产物；
3. Pull Request 完成后不创建或更新任何 Release。

执行 `make client-p` 发布完成后，安装脚本使用的下载地址是：

```text
https://github.com/Alano-i/open-xiaoai/releases/download/client-latest/client
```

### 发布最新补丁固件

`.github/workflows/OH2P.yaml` 和 `.github/workflows/LX06.yaml` 需要手动运行，分别对应
Xiaomi 智能音箱 Pro（OH2P）和小爱音箱 Pro（LX06）。工作流会获取指定 OTA 固件，在 Docker
中执行提取、补丁和 SquashFS 重打包，然后创建对应的 GitHub Release：

- OH2P：`OH2P_<版本号>`
- LX06：`LX06_<版本号>`

操作步骤：

1. 在本地 `packages/client-patch/.env` 填写小米账号信息，确保可以读取设备 OTA 信息；
2. 执行下面命令生成本次 OTA 参数 JSON（版本号替换成音箱当前版本）：

   ```shell
   cd packages/client-patch
   DEBUG_VERSION=1.62.2 npm run ota
   ```

   将命令输出的 JSON 压缩为一行并复制下来，格式类似：

   ```json
   {"sn":"","model":"OH2P","version":"1.62.2","url":"https://..."}
   ```

3. 打开 GitHub **Actions**，选择对应的 OH2P 或 LX06 工作流，点击 **Run workflow**，在
   `ota` 输入框粘贴上面的 JSON；
4. 工作流完成后，在新 Release 的附件中下载：
   - `*_patched.squashfs`：已打补丁固件，用于刷入；
   - `*.squashfs`：原版固件，用于需要时刷回原系统。

固件必须与音箱型号和版本匹配，禁止跨型号或跨版本直接刷写。工作流使用当前仓库的
`packages/client-patch/patches`，但构建容器仍是 `idootop/open-xiaoai:latest`；如果修改了
固件构建脚本或工具链，建议先在本地执行 `npm run build` 验证后再发布。

## PodSuite 播客助手（MiGPT）

`examples/migpt` 现已包含可独立 Docker 部署的 MiGPT 服务端：管理端口 `4398`、音箱
WebSocket 端口 `4399`（可用 `MIGPT_WS_PORT` 修改），控制台支持音箱登记与连接状态、模型和
系统提示词下发、播放/暂停/停止、上一集/下一集、断点续播、定时停止、对话与播放历史查看。
当前一个 MiGPT 进程只维护一个活动音箱连接，登记音箱不会自动 SSH 刷机或部署客户端。

MiGPT 通过 PodSuite 的 `/api/integrations/migpt/v1` 接口读取节目 RSS 和保存进度。启动后在
MiGPT 管理页面“配置”中填写 PodSuite 地址、两端一致的集成 Token，以及模型接口和密钥；
配置会保存到挂载目录 `/data/config.json`，不会写入镜像或代码。并把音频 URL 配置成音箱
可访问的地址。OH2P 使用固件内置实验模式让小米只返回 ASR：播客由 MiGPT 执行，其他命令
再显式转交给原生服务一次，避免一条语音触发两个助理。

## 相关项目

> [!TIP]
> 技术的意义在于分享与共创。如果你打算或正在使用本项目做些有趣的事情，
> 欢迎提交 PR 或 issue 分享你的项目和创意。✨

如果你不想刷机，或者不是小爱音箱 Pro，下面的项目或许对你有用：

- https://github.com/idootop/mi-gpt
- https://github.com/idootop/migpt-next
- https://github.com/yihong0618/xiaogpt
- https://github.com/hanxi/xiaomusic

## 参考链接

如果你想要了解更多技术细节，下面的链接可能对你有用：

- https://github.com/yihong0618/gitblog/issues/258
- https://github.com/jialeicui/open-lx01
- https://github.com/duhow/xiaoai-patch
- https://javabin.cn/2021/xiaoai_fm.html
- https://xuanxuanblingbling.github.io/iot/2022/09/16/mi/

## 免责声明

1. **适用范围**
   本项目为开源非营利项目，仅供学术研究或个人测试用途。严禁用于商业服务、网络攻击、数据窃取、系统破坏等违反《网络安全法》及使用者所在地司法管辖区的法律规定的场景。
2. **非官方声明**
   本项目由第三方开发者独立开发，与小米集团及其关联方（下称"权利方"）无任何隶属/合作关系，亦未获其官方授权/认可或技术支持。项目中涉及的商标、固件、云服务的所有权利归属小米集团。若权利方主张权益，使用者应立即主动停止使用并删除本项目。

继续下载或运行本项目，即表示您已完整阅读并同意[用户协议](agreement.md)，否则请立即终止使用并彻底删除本项目。

## License

MIT License © 2024-PRESENT [Del Wang](https://del.wang)
