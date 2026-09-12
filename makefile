# MiGPT 多架构 Docker 镜像构建与推送。
# 执行 `make docker-migpt` 前，请先使用 `docker login` 登录 Docker Hub。

IMAGE ?= alanoo/migpt:latest
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER ?= multiarch-builder
DOCKERFILE ?= examples/migpt/Dockerfile
CONTEXT ?= .

.PHONY: docker-migpt client client-p img img-push

# 编译并部署小爱音箱 Client，同时更新音箱上的 /data/init.sh。
# 默认读取 packages/client-rust/.env；命令行环境变量可覆盖其中的同名配置。
client:
	@packages/client-rust/deploy.sh

# 编译 Client 并发布到 GitHub 的 client-latest Release，不安装到音箱。
client-p:
	@packages/client-rust/publish-release.sh

# 使用当前仓库代码构建 OH2P 补丁固件，产物保存在 packages/client-patch/assets。
img:
	@packages/client-patch/build-oh2p.sh

# 构建 OH2P 固件并发布 OH2P_<版本> Release。
img-push: img
	@packages/client-patch/publish-oh2p-release.sh

# 使用 Buildx 构建并直接推送 amd64/arm64 镜像清单。
docker-migpt:
	@set -e; \
	if ! docker buildx inspect "$(BUILDER)" >/dev/null 2>&1; then \
		echo "创建 Buildx 构建器：$(BUILDER)"; \
		docker buildx create --name "$(BUILDER)" --driver docker-container --use >/dev/null; \
	else \
		docker buildx use "$(BUILDER)"; \
	fi; \
	docker buildx inspect "$(BUILDER)" --bootstrap >/dev/null; \
	echo "构建并推送 $(IMAGE)（平台：$(PLATFORMS)）"; \
	docker buildx build \
		--builder "$(BUILDER)" \
		--platform "$(PLATFORMS)" \
		-f "$(DOCKERFILE)" \
		-t "$(IMAGE)" \
		--push \
		"$(CONTEXT)"
