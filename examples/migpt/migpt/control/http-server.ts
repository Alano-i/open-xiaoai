/** MiGPT 管理 HTTP 服务：提供白名单播放器控制、配置、设备、对话和定时器 API。 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PodcastController } from "../podcast/controller.js";
import type { PodcastSpeaker } from "../podcast/controller.js";
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
}

type ConfigPatch = Partial<MigptRuntimeConfig> & { openai?: Partial<MigptRuntimeConfig["openai"]>; prompt?: Partial<MigptRuntimeConfig["prompt"]> };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

export class ControlServer {
  private readonly server;
  constructor(
    private readonly config: MigptRuntimeConfig,
    private readonly configStore: JsonStore<MigptRuntimeConfig>,
    private readonly controller: PodcastController,
    private readonly speaker: PodcastSpeaker,
    private readonly conversations: ConversationStore,
    private readonly webRoot: string,
    private readonly onConfigUpdate?: (config: MigptRuntimeConfig) => void,
    private readonly getConnectionStatus?: () => MigptConnectionStatus,
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
      return this.json(response, 200, { ok: true, service: "migpt" });
    }
    if (url.pathname.startsWith("/api/") && !this.authorized(request)) return this.json(response, 401, { error: "未授权" });
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
    if (url.pathname === "/api/migpt/v1/conversations" && request.method === "GET") return this.json(response, 200, this.conversations.list());
    if (url.pathname === "/api/migpt/v1/playback/history" && request.method === "GET") {
      return this.json(response, 200, await this.controller.history());
    }
    if (url.pathname.startsWith("/api/migpt/v1/player/")) {
      const command = url.pathname.split("/").pop();
      if (request.method === "POST" && command === "play") {
        const body = await this.body<{ query?: string; season?: number; episode?: number }>(request);
        if (body.query) {
          const selection = `${body.query}${body.season ? `第${body.season}季` : ""}${body.episode ? `第${body.episode}集` : ""}`;
          return this.json(response, 200, await this.controller.handle(`播放播客${selection}`));
        }
        return this.json(response, 200, await this.controller.handle("继续播放"));
      }
      if (request.method === "POST" && command === "seek") {
        const body = await this.body<{ position_ms?: number }>(request);
        return this.json(response, 200, { success: await this.speaker.seek(Number(body.position_ms || 0)) });
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

  private publicConfig() {
    return { ...this.config, apiToken: this.config.apiToken ? "********" : "", podsuiteToken: this.config.podsuiteToken ? "********" : "", openai: { ...this.config.openai, apiKey: this.config.openai.apiKey ? "********" : "" } };
  }

  private async playerStatus() {
    return {
      status: await this.speaker.getPlaying(true),
      current: this.controller.current,
      playback: await this.speaker.getPlaybackContext().catch(() => ({})),
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
      response.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch (_) { this.json(response, 404, { error: "Not found" }); }
  }
}
