/**
 * 倍速播放音频流。
 *
 * 小米音箱的 mediaplayer 不支持调整播放速度，因此倍速由 MiGPT 服务端实现：
 * 用 ffmpeg 的 atempo 滤镜（变速不变调）把原始音频实时转码为指定倍速的 MP3，
 * 音箱像播放普通网络音频一样播放 `http://<MiGPT>/stream/<会话 ID>.mp3`。
 *
 * 关键约定：
 * - 每次开始播放（含跳转、切换倍速）都会创建一个新会话：从原始音频的 startMs 处开始转码，
 *   所以音箱上报的播放位置是“本次流内的时间”，原始位置 = startMs + 流内位置 × 倍速，
 *   换算由 PodcastController 负责。
 * - 流地址不带鉴权（音箱无法附加请求头），只认随机会话 ID，且只保留最近几个会话；
 *   客户端无法借此转码任意地址。
 * - 新会话创建时结束旧会话的 ffmpeg 进程，同一时间只有当前节目在转码。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 本进程的随机实例 ID，由 /api/migpt/v1/health 返回。探测倍速流地址时据此确认
 * 音箱访问到的就是当前这台 MiGPT，而不是同一网络里的另一个实例。
 */
export const MIGPT_INSTANCE_ID = randomUUID();

/** 管理页可选择的倍速档位，1 表示直接播放原始音频、不经过 ffmpeg。 */
export const PLAYBACK_SPEEDS = [1, 1.3, 1.5, 1.8, 2, 2.5, 3] as const;

export function isSupportedSpeed(value: unknown): value is number {
  return typeof value === "number" && (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

/** 转码输出为恒定码率 MP3，兼容性最好；128 kbps 对人声节目绰绰有余。 */
const OUTPUT_BITRATE = "128k";
/** 只保留最近几个会话：音箱可能对同一地址重复请求，旧会话的地址很快就不再需要。 */
const MAX_SESSIONS = 4;
const STREAM_PATH = /^\/stream\/([0-9a-f-]{36})\.mp3$/;

export interface SpeedStream {
  /** 本次流在音箱播放器中的 audio_id，用于区分新旧流上报的位置。 */
  audioId: string;
  url: string;
}

interface StreamSession {
  id: string;
  sourceUrl: string;
  startMs: number;
  speed: number;
  /** 从 ffmpeg 输出里解析出的原始音频总时长，PodSuite 没有时长时用它兜底。 */
  sourceDurationMs?: number;
  processes: Set<ChildProcess>;
}

export interface SpeedStreamOptions {
  /** 返回音箱能访问到的 MiGPT 管理服务地址（如 http://192.168.1.10:4398），无法确定时返回 undefined。 */
  resolveBaseUrl: () => Promise<string | undefined>;
  ffmpegPath?: string;
}

export class SpeedStreamManager {
  private readonly sessions = new Map<string, StreamSession>();
  private ffmpegCheck?: Promise<boolean>;
  private readonly ffmpegPath: string;

  constructor(private readonly options: SpeedStreamOptions) {
    this.ffmpegPath = options.ffmpegPath || process.env.MIGPT_FFMPEG || "ffmpeg";
  }

  /** ffmpeg 是否可用；结果只检测一次。 */
  available() {
    this.ffmpegCheck ??= new Promise<boolean>((resolve) => {
      const child = spawn(this.ffmpegPath, ["-hide_banner", "-version"], { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    }).then((ok) => {
      if (!ok) console.error(`❌ 未找到可用的 ffmpeg（${this.ffmpegPath}），倍速播放不可用，将按原速播放`);
      return ok;
    });
    return this.ffmpegCheck;
  }

  /**
   * 创建一个从原始音频 startMs 处开始、按 speed 倍速转码的流。
   * 失败时抛出带中文说明的错误，由调用方决定是否回退到原速播放。
   */
  async create(sourceUrl: string, startMs: number, speed: number): Promise<SpeedStream> {
    if (!(await this.available())) throw new Error("MiGPT 未安装 ffmpeg，无法倍速播放");
    const baseUrl = await this.options.resolveBaseUrl();
    if (!baseUrl) {
      throw new Error("音箱无法访问 MiGPT 管理端口，请设置环境变量 MIGPT_STREAM_BASE_URL 为音箱能访问的地址（例如 http://192.168.1.10:4398）");
    }
    // 音箱同一时间只播放一个节目；旧会话的转码进程立即结束，避免占用 CPU 和源站连接。
    for (const session of this.sessions.values()) this.killSession(session);
    const session: StreamSession = {
      id: randomUUID(),
      sourceUrl,
      startMs: Math.max(0, Math.round(startMs)),
      speed,
      processes: new Set(),
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
    return {
      audioId: `speed-${session.id}`,
      url: `${baseUrl.replace(/\/+$/, "")}/stream/${session.id}.mp3`,
    };
  }

  /** 原始音频总时长（毫秒），ffmpeg 尚未读到文件头时为 undefined。 */
  sourceDuration(audioId: string) {
    return this.sessions.get(audioId.replace(/^speed-/, ""))?.sourceDurationMs;
  }

  /** 处理音箱的拉流请求；不是倍速流路径时返回 false 交给其他路由。 */
  handle(request: IncomingMessage, response: ServerResponse, pathname: string) {
    const match = pathname.match(STREAM_PATH);
    if (!match) return false;
    const session = this.sessions.get(match[1] || "");
    if (!session || !["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("倍速音频流不存在或已过期");
      return true;
    }
    const headers = {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      // 转码流无法按字节定位；跳转由 MiGPT 重新创建会话实现。
      "Accept-Ranges": "none",
    };
    if (request.method === "HEAD") {
      response.writeHead(200, headers);
      response.end();
      return true;
    }
    this.pipe(session, response, headers);
    return true;
  }

  private pipe(session: StreamSession, response: ServerResponse, headers: Record<string, string>) {
    const args = [
      "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
      // 源站（PodSuite/115 直链）中途断开时按已读位置自动续传，避免长时间暂停后恢复播放失败。
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
      "-rw_timeout", "30000000",
      "-ss", (session.startMs / 1000).toFixed(3),
      "-i", session.sourceUrl,
      "-vn", "-map", "0:a:0",
      "-af", `atempo=${session.speed}`,
      "-c:a", "libmp3lame", "-b:a", OUTPUT_BITRATE, "-ar", "44100",
      // 管道输出无法回写 Xing 头，不写入可避免播放器按错误的帧数估算时长。
      "-write_xing", "0", "-id3v2_version", "0",
      "-f", "mp3", "pipe:1",
    ];
    const child = spawn(this.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    session.processes.add(child);
    let stderrTail = "";
    let started = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      if (session.sourceDurationMs === undefined) {
        // stderr 可能在任意位置分块，用累积的尾部匹配。
        const duration = stderrTail.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
        if (duration) {
          session.sourceDurationMs = Math.round(
            (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
          );
        }
      }
    });
    // 等 ffmpeg 产出第一段数据再返回 200：源地址打不开时返回 502，音箱能立即报错而不是一直缓冲。
    child.stdout.once("data", (chunk: Buffer) => {
      started = true;
      response.writeHead(200, headers);
      response.write(chunk);
      child.stdout.pipe(response);
    });
    const cleanup = () => {
      session.processes.delete(child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    // 音箱停止、切歌或断开连接时立即结束转码。
    response.once("close", cleanup);
    child.once("error", (error) => {
      console.error("❌ 启动 ffmpeg 失败，倍速音频无法播放", error);
      if (!started && !response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("ffmpeg 启动失败");
      }
    });
    child.once("exit", (code, signal) => {
      session.processes.delete(child);
      if (code && !signal) {
        console.error("❌ 倍速转码失败，请检查音频地址是否可访问", { code, detail: stderrTail.trim().split("\n").slice(-3).join(" | ") });
      }
      // 已开始输出时 stdout 的 pipe 会自动结束响应；这里只处理一字节都没产出的失败。
      if (!started && !response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("倍速转码失败");
      }
    });
  }

  private killSession(session: StreamSession) {
    for (const child of session.processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    session.processes.clear();
  }
}

/**
 * 从音箱上 open-xiaoai 客户端连接的服务端地址推算 MiGPT 管理服务地址（仅作候选，需探测确认）：
 * ws://192.168.1.10:4399 → http://192.168.1.10:<管理端口>；
 * wss://mi.example.com → https://mi.example.com（反向代理同时转发了管理页时才可用）。
 */
export function streamBaseFromServerUrl(serverUrl: string, controlPort: number) {
  try {
    const url = new URL(serverUrl.trim());
    if (url.protocol === "ws:") return normalizeStreamBase(`http://${url.hostname}:${controlPort}`);
    if (url.protocol === "wss:") return normalizeStreamBase(`https://${url.host}`);
  } catch (_) { /* 地址无效时不作为候选 */ }
  return undefined;
}

/**
 * 规范化候选地址，只保留协议、主机和端口。候选可能来自请求的 Host 头，
 * 之后会拼进音箱上执行的 curl 命令，因此主机名只允许字母、数字和 . - : [ ]。
 */
export function normalizeStreamBase(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !/^[a-z0-9.\-:[\]]+$/i.test(url.host)) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return undefined;
  }
}

/**
 * 按顺序探测候选地址，返回第一个确认指向本实例的地址。
 * probe 负责从音箱上请求健康检查地址并返回响应正文（音箱上执行 curl）。
 */
export async function findReachableStreamBase(
  candidates: Array<string | undefined>,
  probe: (healthUrl: string) => Promise<string | undefined>,
) {
  const unique = [...new Set(candidates.map(normalizeStreamBase).filter((item): item is string => Boolean(item)))];
  for (const base of unique) {
    const body = await probe(`${base}/api/migpt/v1/health`).catch(() => undefined);
    if (body?.includes(MIGPT_INSTANCE_ID)) return base;
  }
  return undefined;
}
