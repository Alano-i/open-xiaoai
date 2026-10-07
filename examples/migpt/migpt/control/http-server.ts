/** MiGPT 管理 HTTP 服务：提供白名单播放器控制、配置、设备、对话和定时器 API。 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PodcastController } from "../podcast/controller.js";
import type { PodcastSpeaker } from "../podcast/controller.js";
import { MIGPT_INSTANCE_ID, type SpeedStreamManager } from "../podcast/speed-stream.js";
import { JsonStore, ConversationStore } from "../persistence.js";
import type { MigptConnectionStatus } from "../xiaoai.js";

export interface MigptRuntimeConfig {
  configVersion?: number;
  host: string;
  port: number;
  apiToken: string;
  podsuiteUrl: string;
  podsuiteToken: string;
  openai: { baseURL: string; apiKey: string; model: string };
  prompt: { system: string };
  devices: Array<Record<string, unknown>>;
  /** 播客倍速，管理页切换后保存，重启后继续使用。 */
  playbackSpeed?: number;
  /** 最近一次探测成功的倍速流地址（音箱能访问到的 MiGPT 管理地址），重启后优先使用。 */
  streamBaseUrl?: string;
}

type ConfigPatch = Partial<MigptRuntimeConfig> & { openai?: Partial<MigptRuntimeConfig["openai"]>; prompt?: Partial<MigptRuntimeConfig["prompt"]> };

// 管理页由 PodSuite 助手页源码构建，产物包含字体、图标等静态资源。
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export class ControlServer {
  private readonly server;
  /** 已通过鉴权的管理请求所用的 Host（最近几个），作为倍速流地址的候选。 */
  private readonly requestHosts: string[] = [];
  constructor(
    private readonly config: MigptRuntimeConfig,
    private readonly configStore: JsonStore<MigptRuntimeConfig>,
    private readonly controller: PodcastController,
    private readonly speaker: PodcastSpeaker,
    private readonly conversations: ConversationStore,
    private readonly webRoot: string,
    private readonly onConfigUpdate?: (config: MigptRuntimeConfig) => void,
    private readonly getConnectionStatus?: () => MigptConnectionStatus,
    private readonly streams?: SpeedStreamManager,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error("❌ 管理 API 请求失败", error);
        if (!response.headersSent) this.json(response, 400, { error: "请求格式无效" });
        else response.end();
      });
    });
  }

  listen() {
    const port = Number(process.env.MIGPT_PORT || this.config.port || 4398);
    const host = process.env.MIGPT_HOST || this.config.host || "0.0.0.0";
    this.server.listen(port, host, () => console.log(`✅ MiGPT 管理页面：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`));
  }

  private authorized(request: IncomingMessage) {
    if (!this.config.apiToken) return true;
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return token === this.config.apiToken;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" });
      return response.end();
    }
    if (url.pathname === "/api/migpt/v1/health") {
      response.setHeader("Cache-Control", "no-store");
      return this.json(response, 200, { ok: true, service: "migpt", instance: MIGPT_INSTANCE_ID });
    }
    // 倍速音频流供音箱拉取，音箱无法附加 Authorization 头；地址只认随机会话 ID。
    if (this.streams?.handle(request, response, url.pathname)) return;
    if (url.pathname.startsWith("/api/") && !this.authorized(request)) return this.json(response, 401, { error: "未授权" });
    if (url.pathname.startsWith("/api/")) this.rememberHost(request.headers.host);
    if ((url.pathname === "/api/migpt/v1/status" || url.pathname === "/api/migpt/v1/player") && request.method === "GET") {
      return this.json(response, 200, await this.playerStatus());
    }
    if (url.pathname === "/api/migpt/v1/config") {
      if (request.method === "GET") return this.json(response, 200, this.publicConfig());
      if (request.method === "PUT") {
        const patch = await this.body<ConfigPatch>(request);
        // 页面会把已存在的密钥显示为 ********，不能让这个占位符覆盖真实密钥。
        const apiToken = patch.apiToken === "********" ? undefined : patch.apiToken;
        const podsuiteToken = patch.podsuiteToken === "********" ? undefined : patch.podsuiteToken;
        const apiKey = patch.openai?.apiKey === "********" ? undefined : patch.openai?.apiKey;
        const sanitizedPatch = { ...patch };
        if (apiToken === undefined && patch.apiToken !== undefined) sanitizedPatch.apiToken = this.config.apiToken;
        if (podsuiteToken === undefined && patch.podsuiteToken !== undefined) sanitizedPatch.podsuiteToken = this.config.podsuiteToken;
        const openaiPatch = { ...patch.openai };
        if (apiKey === undefined && patch.openai?.apiKey !== undefined) openaiPatch.apiKey = this.config.openai.apiKey;
        Object.assign(this.config, {
          ...sanitizedPatch,
          openai: { ...this.config.openai, ...openaiPatch },
          prompt: { ...this.config.prompt, ...patch.prompt },
        });
        await this.configStore.save(this.config);
        this.onConfigUpdate?.(this.config);
        return this.json(response, 200, this.publicConfig());
      }
    }
    if (url.pathname === "/api/migpt/v1/devices") {
      if (request.method === "GET") return this.json(response, 200, this.devicesWithStatus());
      if (request.method === "POST") {
        const device = await this.body<Record<string, unknown>>(request);
        device.id = device.id || randomUUID();
        this.config.devices = [...(this.config.devices || []), device];
        await this.configStore.save(this.config);
        return this.json(response, 201, device);
      }
    }
    if (url.pathname === "/api/migpt/v1/podcasts/suggest" && request.method === "GET") {
      const query = (url.searchParams.get("q") || "").slice(0, 100);
      return this.forwardPodsuite(response, () => this.controller.suggestPodcasts(query));
    }
    const upcoming = url.pathname.match(/^\/api\/migpt\/v1\/episodes\/([^/]+)\/upcoming$/);
    if (upcoming && request.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return this.forwardPodsuite(response, () => this.controller.upcomingEpisodes(decodeURIComponent(upcoming[1] || ""), limit));
    }
    if (url.pathname === "/api/migpt/v1/conversations" && request.method === "GET") return this.json(response, 200, this.conversations.list());
    if (url.pathname === "/api/migpt/v1/playback/history" && request.method === "GET") {
      return this.json(response, 200, await this.controller.history());
    }
    if (url.pathname.startsWith("/api/migpt/v1/player/")) {
      const command = url.pathname.split("/").pop();
      if (request.method === "POST" && command === "play") {
        const body = await this.body<{ episode_id?: string; query?: string; season?: number; episode?: number }>(request);
        if (body.episode_id) return this.json(response, 200, await this.controller.playEpisode(String(body.episode_id)));
        if (body.query) {
          const selection = `${body.query}${body.season ? `第${body.season}季` : ""}${body.episode ? `第${body.episode}集` : ""}`;
          return this.json(response, 200, await this.controller.handle(`播放播客${selection}`));
        }
        return this.json(response, 200, await this.controller.handle("继续播放"));
      }
      if (request.method === "POST" && command === "seek") {
        const body = await this.body<{ position_ms?: number }>(request);
        return this.json(response, 200, await this.controller.seek(Number(body.position_ms || 0)));
      }
      if (request.method === "POST" && command === "volume") {
        const body = await this.body<{ volume?: number }>(request);
        const volume = Number(body.volume);
        if (!Number.isFinite(volume)) return this.json(response, 400, { error: "音量必须是 0-100 的数字" });
        return this.json(response, 200, { success: await this.speaker.setVolume?.(volume) ?? false });
      }
      if (request.method === "POST" && command === "speed") {
        const body = await this.body<{ speed?: number }>(request);
        const result = await this.controller.setSpeed(Number(body.speed));
        if (result.speed !== this.config.playbackSpeed) {
          this.config.playbackSpeed = result.speed;
          await this.configStore.save(this.config);
        }
        return this.json(response, 200, result);
      }
      const commands: Record<string, string> = { pause: "暂停播客", resume: "继续播放", stop: "停止播客", next: "播放下一集", previous: "播放上一集", restart: "从头播放播客" };
      if (request.method === "POST" && command && commands[command]) {
        const result = await this.controller.handle(commands[command]);
        return this.json(response, 200, result);
      }
    }
    if (url.pathname === "/api/migpt/v1/player/timer") {
      if (request.method === "GET") return this.json(response, 200, { timer_until: this.controller.timerUntil || null });
      if (request.method === "DELETE") return this.json(response, 200, await this.controller.handle("取消定时停止"));
      if (request.method === "POST") {
        const body = await this.body<{ minutes?: number }>(request);
        return this.json(response, 200, await this.controller.handle(`${Number(body.minutes || 0)}分钟后停止播放`));
      }
    }
    if (url.pathname.startsWith("/api/migpt/v1/devices/") && ["PUT", "DELETE"].includes(request.method || "")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const index = (this.config.devices || []).findIndex((device) => String(device.id || "") === id);
      if (index < 0) return this.json(response, 404, { error: "音箱不存在" });
      if (request.method === "DELETE") this.config.devices.splice(index, 1);
      else this.config.devices[index] = { ...this.config.devices[index], ...(await this.body<Record<string, unknown>>(request)) };
      await this.configStore.save(this.config);
      return this.json(response, 200, request.method === "DELETE" ? { deleted: true } : this.config.devices[index]);
    }
    return this.static(url.pathname, response);
  }

  /**
   * PodSuite 代理或浏览器访问管理接口时用的地址（如 10.10.10.10:4398）往往也是音箱能访问的地址，
   * 记录下来供倍速流探测；是否可用由音箱实际探测决定。
   */
  private rememberHost(host: string | undefined) {
    if (!host) return;
    const index = this.requestHosts.indexOf(host);
    if (index >= 0) this.requestHosts.splice(index, 1);
    this.requestHosts.unshift(host);
    this.requestHosts.splice(5);
  }

  get recentRequestHosts() { return [...this.requestHosts]; }

  /** 转发 PodSuite 查询；PodSuite 未配置或不可用时返回 502 和具体原因，而不是笼统的“请求格式无效”。 */
  private async forwardPodsuite(response: ServerResponse, load: () => Promise<unknown>) {
    try {
      return this.json(response, 200, await load());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.json(response, 502, { error: `读取 PodSuite 失败：${message}` });
    }
  }

  private publicConfig() {
    return { ...this.config, apiToken: this.config.apiToken ? "********" : "", podsuiteToken: this.config.podsuiteToken ? "********" : "", openai: { ...this.config.openai, apiKey: this.config.openai.apiKey ? "********" : "" } };
  }

  private async playerStatus() {
    return {
      status: await this.speaker.getPlaying(true),
      current: await this.controller.currentForStatus(),
      playback: this.controller.playbackForStatus(await this.speaker.getPlaybackContext().catch(() => ({}))),
      speed: this.controller.speed,
      timer_until: this.controller.timerUntil || null,
      connection: this.getConnectionStatus?.() || { connected: false },
    };
  }

  private devicesWithStatus() {
    const devices = this.config.devices || [];
    const connection = this.getConnectionStatus?.() || { connected: false };
    const address = String(connection.address || "").replace(/^::ffff:/, "").split(":")[0];
    return devices.map((device) => {
      const configuredAddress = String(device.ip || device.address || "").replace(/^::ffff:/, "").split(":")[0];
      const connected = Boolean(connection.connected && (
        configuredAddress && configuredAddress === address
        || !configuredAddress && devices.length === 1
      ));
      return { ...device, connected };
    });
  }

  private async body<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  }

  private json(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  }

  private async static(pathname: string, response: ServerResponse) {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const root = resolve(this.webRoot);
    const file = resolve(root, requested.replace(/^\/+/, ""));
    const fileRelative = relative(root, file);
    if (fileRelative === ".." || fileRelative.startsWith(`..${sep}`)) return this.json(response, 403, { error: "禁止访问" });
    try {
      const body = await readFile(file);
      // 构建产物 assets/ 下的文件名带内容哈希，可长期缓存；index.html 必须每次重新获取。
      const cacheControl = fileRelative.startsWith(`assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      response.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": cacheControl });
      response.end(body);
    } catch (_) { this.json(response, 404, { error: "Not found" }); }
  }
}
