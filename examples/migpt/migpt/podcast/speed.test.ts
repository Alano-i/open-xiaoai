/** 倍速播放回归测试：位置换算、跳转、暂停时切换倍速、ffmpeg 不可用时回退原速，以及真实 ffmpeg 转码。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PodcastApiClient } from "./api-client.js";
import { PodcastController, type PodcastSpeaker } from "./controller.js";
import {
  MIGPT_INSTANCE_ID,
  SpeedStreamManager,
  findReachableStreamBase,
  normalizeStreamBase,
  streamBaseFromServerUrl,
} from "./speed-stream.js";
import type { Episode, Progress } from "./types.js";

function createHarness(options: { streamFails?: boolean; contextDelayMs?: number } = {}) {
  const episode: Episode = {
    episode_id: "episode-1",
    podcast_id: "podcast-1",
    podcast_title: "倍速播客",
    title: "第1集",
    season: 1,
    episode: 1,
    audio_url: "https://example.com/episode-1.mp3",
    duration_ms: 600_000,
    progress: { episode_id: "episode-1", position_ms: 60_000, duration_ms: 600_000, status: "paused" },
  };
  const nextEpisode: Episode = {
    ...episode,
    episode_id: "episode-2",
    title: "第2集",
    episode: 2,
    audio_url: "https://example.com/episode-2.mp3",
    progress: null,
  };
  const saved: Progress[] = [];
  const completed: string[] = [];
  const api = {
    async getEpisode(id: string) { return id === nextEpisode.episode_id ? nextEpisode : episode; },
    // 自动下一集按季集查询，这里固定返回第 2 集。
    async resolveEpisode() { return nextEpisode; },
    async complete(id: string) {
      completed.push(id);
      const result = { episode_id: id, position_ms: 0, duration_ms: episode.duration_ms, status: "completed" };
      if (id === episode.episode_id) episode.progress = result;
      return result;
    },
    async getCurrentProgress() { return episode.progress; },
    async saveProgress(episodeId: string, progress: Omit<Progress, "episode_id">) {
      const result = { episode_id: episodeId, ...progress };
      saved.push(result);
      episode.progress = result;
      return result;
    },
  } as unknown as PodcastApiClient;

  const created: Array<{ url: string; startMs: number; speed: number }> = [];
  const streams = {
    async create(url: string, startMs: number, speed: number) {
      if (options.streamFails) throw new Error("MiGPT 未安装 ffmpeg，无法倍速播放");
      created.push({ url, startMs, speed });
      return { audioId: `speed-${created.length}`, url: `http://migpt/stream/${created.length}.mp3` };
    },
    sourceDuration() { return undefined; },
  } as unknown as SpeedStreamManager;

  let status: "playing" | "paused" | "idle" = "idle";
  let context: Record<string, unknown> = {};
  const playCalls: Array<Record<string, unknown>> = [];
  const seeks: number[] = [];
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(call) {
      playCalls.push(call);
      if (call.url) {
        status = "playing";
        context = { audio_id: call.audioId, position: 0 };
      }
      return true;
    },
    async setPlaying(playing = true) { status = playing ? "playing" : "paused"; return true; },
    async stop() { status = "idle"; return true; },
    async getPlaying() { return status; },
    async getPlaybackContext() {
      // 模拟真实 RPC 的延迟：返回的是调用时刻的播放器状态。
      const snapshot = context;
      if (options.contextDelayMs) await new Promise((resolve) => setTimeout(resolve, options.contextDelayMs));
      return snapshot;
    },
    async seek(positionMs) { seeks.push(positionMs); context = { ...context, position: positionMs }; return true; },
  };
  const controller = new PodcastController(api, speaker, undefined, { streams });
  return {
    controller, episode, nextEpisode, saved, completed, created, playCalls, seeks,
    setContext(next: Record<string, unknown>) { context = next; },
    setStatus(next: "playing" | "paused" | "idle") { status = next; },
    get status() { return status; },
  };
}

test("倍速播放从断点开始转码，位置按倍速换算回原始时间", async () => {
  const h = createHarness();
  await h.controller.setSpeed(1.5);
  await h.controller.playEpisode("episode-1");
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 60_000, speed: 1.5 });
  assert.equal(h.playCalls.at(-1)?.url, "http://migpt/stream/1.mp3");
  assert.equal(h.playCalls.at(-1)?.durationMs, 360_000);
  assert.deepEqual(h.seeks, [], "转码流从断点开始，不需要 seek");

  // 流内播放了 10 秒，相当于原始音频 15 秒。
  h.setContext({ audio_id: "speed-1", position: 10_000, duration: 360_000 });
  const playback = h.controller.playbackForStatus({ audio_id: "speed-1", position: 10_000, duration: 360_000 });
  assert.equal(playback.position_ms, 75_000);
  assert.equal(playback.duration_ms, 600_000);

  // 旧流的上下文（audio_id 不同）不能按新流换算，新流装载前以流的起点为准。
  assert.equal(h.controller.playbackForStatus({ audio_id: "episode-1", position: 5_000 }).position_ms, 60_000);

  await h.controller.handle("暂停播客");
  assert.equal(h.saved.at(-1)?.position_ms, 75_000);
  assert.equal(h.saved.at(-1)?.status, "paused");
});

test("倍速播放中跳转会从目标位置重新拉流", async () => {
  const h = createHarness();
  await h.controller.setSpeed(2);
  await h.controller.playEpisode("episode-1");
  const result = await h.controller.seek(300_000);
  assert.equal(result.success, true);
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 300_000, speed: 2 });
  assert.deepEqual(h.seeks, []);
});

test("暂停时切换倍速或跳转，继续播放时从保存的断点按新倍速拉流", async () => {
  const h = createHarness();
  await h.controller.setSpeed(2.5);
  await h.controller.playEpisode("episode-1");
  h.setContext({ audio_id: "speed-1", position: 4_000 });
  await h.controller.handle("暂停播客");
  assert.equal(h.saved.at(-1)?.position_ms, 70_000);

  await h.controller.setSpeed(3);
  assert.equal(h.created.length, 1, "暂停时切换倍速不立即拉流");
  await h.controller.seek(120_000);
  assert.equal(h.saved.at(-1)?.position_ms, 120_000);
  assert.equal(h.controller.playbackForStatus({ audio_id: "speed-1", position: 8_000 }).position_ms, 120_000);

  await h.controller.handle("继续播放");
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 120_000, speed: 3 });
  assert.equal(h.status, "playing");
});

test("MiGPT 重启后音箱里是原速音频：继续播放和重选同一倍速都会改为倍速流", async () => {
  const h = createHarness();
  // 模拟重启前以原速加载并暂停，重启后从 config.json 恢复了 1.5 倍速。
  await h.controller.playEpisode("episode-1");
  h.setContext({ audio_id: "episode-1", position: 90_000 });
  await h.controller.handle("暂停播客");
  h.controller.restoreSpeed(1.5);
  await h.controller.handle("继续播放");
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 90_000, speed: 1.5 });

  // 播放中但实际是原速（例如倍速流曾回退）时，重选同一档位也要重新拉流。
  const h2 = createHarness();
  await h2.controller.playEpisode("episode-1");
  h2.controller.restoreSpeed(2);
  h2.setContext({ audio_id: "episode-1", position: 100_000 });
  await h2.controller.setSpeed(2);
  assert.deepEqual(h2.created.at(-1), { url: h2.episode.audio_url, startMs: 100_000, speed: 2 });
});

test("播放中切回 1 倍速改为直接播放原始音频并 seek 到当前位置", async () => {
  const h = createHarness();
  await h.controller.setSpeed(2);
  await h.controller.playEpisode("episode-1");
  h.setContext({ audio_id: "speed-1", position: 5_000 });
  await h.controller.setSpeed(1);
  assert.equal(h.playCalls.at(-1)?.url, h.episode.audio_url);
  assert.deepEqual(h.seeks, [70_000]);
  // 回到原速后不再换算位置。
  assert.equal(h.controller.playbackForStatus({ audio_id: "episode-1", position: 71_000 }).position, 71_000);
});

test("倍速流不可用时回退原速播放并提示原因", async () => {
  const h = createHarness({ streamFails: true });
  await h.controller.setSpeed(1.5);
  const result = await h.controller.playEpisode("episode-1");
  assert.equal(result.handled, true);
  assert.equal(result.failed, true);
  assert.match(String(result.text), /ffmpeg.*已按原速播放/);
  assert.equal(h.playCalls.at(-1)?.url, h.episode.audio_url);
});

test("不支持的倍速被拒绝且不改变当前设置", async () => {
  const h = createHarness();
  await h.controller.setSpeed(1.5);
  const result = await h.controller.setSpeed(1.75);
  assert.equal(result.failed, true);
  assert.equal(h.controller.speed, 1.5);
});

test("启动时把旧版本保存的倍速换成最接近的新档位", () => {
  const h = createHarness();
  for (const [saved, expected] of [[1.25, 1.3], [1.33, 1.3], [1.75, 1.8], [2, 2], [3, 3], [9, 3]] as const) {
    h.controller.restoreSpeed(saved);
    assert.equal(h.controller.speed, expected, `保存的 ${saved} 应恢复为 ${expected}`);
  }
  h.controller.restoreSpeed(undefined);
  assert.equal(h.controller.speed, 3, "未保存倍速时保持当前值");
});

test("音箱在播放别的音频时不覆盖当前播客的断点", async () => {
  const h = createHarness();
  await h.controller.playEpisode("episode-1");
  h.setContext({ audio_id: "episode-1", position: 70_000, duration: 600_000 });
  await h.controller.handle("暂停播客");
  assert.equal(h.saved.at(-1)?.position_ms, 70_000);
  const savedCount = h.saved.length;

  // 用户让原生小爱放音乐：上下文变成音乐的 audio_id 和进度。
  const music = { audio_id: "native-music-1", position: 1_234, duration: 200_000 };
  h.setContext(music);
  await h.controller.handle("暂停播客");
  assert.equal(h.saved.length, savedCount, "别的音频的进度不能写进播客");
  assert.equal(h.episode.progress?.position_ms, 70_000);
  const playback = h.controller.playbackForStatus(music);
  assert.equal(playback.position_ms, 70_000);
  assert.equal(playback.duration_ms, 600_000);

  // 未上报 audio_id 的旧固件保持原有行为，按当前播客处理。
  h.setContext({ position: 72_000 });
  await h.controller.handle("暂停播客");
  assert.equal(h.saved.at(-1)?.position_ms, 72_000);
});

test("播客被别的音频替换后不判定为播完", async () => {
  const h = createHarness();
  h.episode.duration_ms = 3_000;
  h.episode.progress = { episode_id: "episode-1", position_ms: 2_800, duration_ms: 3_000, status: "paused" };
  await h.controller.playEpisode("episode-1");
  // 不带时长，确保只靠 audio_id 判断（带时长时会因时长不符而碰巧不触发）。
  h.setContext({ audio_id: "native-music-1", position: 0 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(h.completed, [], "不能把别的音频播放当成本集播完并自动下一集");
});

test("切换到下一集时，读取上下文较慢也能保存上一集的断点", async () => {
  const h = createHarness({ contextDelayMs: 20 });
  await h.controller.playEpisode("episode-1");
  h.setContext({ audio_id: "episode-1", position: 90_000 });
  await h.controller.playEpisode("episode-2");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const previous = h.saved.filter((item) => item.episode_id === "episode-1").at(-1);
  assert.equal(previous?.position_ms, 90_000);
  assert.equal(h.saved.some((item) => item.episode_id === "episode-2"), false);
});

test("倍速播放自然播完并自动下一集后，上一集保持已完成，不被结尾处的断点覆盖", async () => {
  const h = createHarness();
  // 从结尾前 7 秒（82.5%，完播检测要求超过 80%）开始 2 倍速播放，真实 3.5 秒后播完，检测约 1.5 秒后开始。
  h.episode.duration_ms = 40_000;
  h.episode.progress = { episode_id: "episode-1", position_ms: 33_000, duration_ms: 40_000, status: "paused" };
  await h.controller.setSpeed(2);
  await h.controller.playEpisode("episode-1");
  assert.equal(h.created.at(-1)?.startMs, 33_000);
  // 流播完：播放器停在流的结尾（流内 3.5 秒 = 原始 7 秒）。
  h.setContext({ audio_id: "speed-1", position: 3_500 });
  h.setStatus("idle");
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  assert.deepEqual(h.completed, ["episode-1"]);
  assert.equal(h.controller.current?.episode_id, "episode-2", "应自动播放下一集");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.saved.some((item) => item.episode_id === "episode-1"), false, "已完成的上一集不能再被保存为暂停");
  assert.equal(h.episode.progress?.status, "completed");

  // 按上一集：已完成的节目从头开始。
  await h.controller.playEpisode("episode-1");
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 0, speed: 2 });
});

test("断点已在结尾附近（旧版本写坏的数据）时从头播放", async () => {
  const h = createHarness();
  h.episode.progress = { episode_id: "episode-1", position_ms: 600_115, duration_ms: 600_000, status: "paused" };
  await h.controller.setSpeed(1.5);
  await h.controller.playEpisode("episode-1");
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 0, speed: 1.5 });

  // 距结尾还有 5 秒以上时照常续播。
  const h2 = createHarness();
  h2.episode.progress = { episode_id: "episode-1", position_ms: 590_000, duration_ms: 600_000, status: "paused" };
  await h2.controller.setSpeed(1.5);
  await h2.controller.playEpisode("episode-1");
  assert.deepEqual(h2.created.at(-1), { url: h2.episode.audio_url, startMs: 590_000, speed: 1.5 });
});

test("倍速播放中拖到结尾附近：新流装载期间仍上报旧流，播完后照常进入下一集", async () => {
  const h = createHarness();
  h.episode.duration_ms = 40_000;
  h.episode.progress = { episode_id: "episode-1", position_ms: 10_000, duration_ms: 40_000, status: "paused" };
  await h.controller.setSpeed(2);
  await h.controller.playEpisode("episode-1");
  // 拖到结尾前 4 秒：2 倍速剩余 2 秒，完播检测 250ms 后就开始。
  await h.controller.seek(36_000);
  assert.deepEqual(h.created.at(-1), { url: h.episode.audio_url, startMs: 36_000, speed: 2 });
  // 播放器还在装载新流，上报的仍是旧流。
  h.setContext({ audio_id: "speed-1", position: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(h.completed, [], "装载期间不能判定播完");
  // 新流播完。
  h.setContext({ audio_id: "speed-2", position: 2_000 });
  h.setStatus("idle");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(h.completed, ["episode-1"]);
  assert.equal(h.controller.current?.episode_id, "episode-2");
});

test("倍速播放中拖到最末尾：不再转码空音频，直接标记完成并进入下一集", async () => {
  const h = createHarness();
  h.episode.duration_ms = 40_000;
  h.episode.progress = { episode_id: "episode-1", position_ms: 10_000, duration_ms: 40_000, status: "paused" };
  await h.controller.setSpeed(1.5);
  await h.controller.playEpisode("episode-1");
  const result = await h.controller.seek(40_000);
  assert.equal(result.success, true);
  assert.equal(h.created.some((item) => item.startMs >= 38_000), false, "不能从结尾创建倍速流");
  assert.deepEqual(h.completed, ["episode-1"]);
  assert.equal(h.controller.current?.episode_id, "episode-2");
  assert.deepEqual(h.created.at(-1), { url: h.nextEpisode.audio_url, startMs: 0, speed: 1.5 });
});

test("设置定时停止后，到点前倍速播完一集仍自动进入下一集", async () => {
  const h = createHarness();
  h.episode.duration_ms = 40_000;
  h.episode.progress = { episode_id: "episode-1", position_ms: 33_000, duration_ms: 40_000, status: "paused" };
  await h.controller.setSpeed(2);
  await h.controller.playEpisode("episode-1");
  await h.controller.handle("30分钟后停止播放");
  assert.ok(h.controller.timerUntil, "应已设置定时停止");
  try {
    h.setContext({ audio_id: "speed-1", position: 3_500 });
    h.setStatus("idle");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.deepEqual(h.completed, ["episode-1"]);
    assert.equal(h.controller.current?.episode_id, "episode-2", "定时未到点时应继续播放下一集");
    assert.deepEqual(h.created.at(-1), { url: h.nextEpisode.audio_url, startMs: 0, speed: 2 });
    assert.ok(h.controller.timerUntil, "进入下一集后定时停止仍然有效");
  } finally {
    await h.controller.handle("取消定时停止");
  }
});

test("由音箱连接地址推算倍速流候选地址", () => {
  assert.equal(streamBaseFromServerUrl("ws://192.168.1.10:4399", 4398), "http://192.168.1.10:4398");
  assert.equal(streamBaseFromServerUrl("ws://migpt.lan:4399/", 4398), "http://migpt.lan:4398");
  assert.equal(streamBaseFromServerUrl("wss://mi.example.com", 4398), "https://mi.example.com");
  assert.equal(streamBaseFromServerUrl("", 4398), undefined);
});

test("候选地址只保留协议、主机和端口，拒绝可注入 shell 的主机名", () => {
  assert.equal(normalizeStreamBase("http://10.10.10.10:4398"), "http://10.10.10.10:4398");
  assert.equal(normalizeStreamBase("http://10.10.10.10:4398/api/x?y=1"), "http://10.10.10.10:4398");
  assert.equal(normalizeStreamBase("http://[::1]:4398"), "http://[::1]:4398");
  assert.equal(normalizeStreamBase("http://a';reboot;'b"), undefined);
  assert.equal(normalizeStreamBase("http://a$(reboot)"), undefined);
  assert.equal(normalizeStreamBase("ftp://10.10.10.10"), undefined);
  assert.equal(normalizeStreamBase(undefined), undefined);
});

test("探测倍速流地址时跳过不可达或属于其他实例的候选", async () => {
  const probed: string[] = [];
  const found = await findReachableStreamBase(
    [undefined, "http://other:4398", "http://bad host", "https://mi.example.com", "http://10.10.10.10:4398", "http://10.10.10.10:4398/"],
    async (url) => {
      probed.push(url);
      if (url.startsWith("http://other")) return JSON.stringify({ ok: true, service: "migpt", instance: "另一个实例" });
      if (url.startsWith("https://mi.example.com")) return undefined;
      return JSON.stringify({ ok: true, service: "migpt", instance: MIGPT_INSTANCE_ID });
    },
  );
  assert.equal(found, "http://10.10.10.10:4398");
  assert.deepEqual(probed, [
    "http://other:4398/api/migpt/v1/health",
    "https://mi.example.com/api/migpt/v1/health",
    "http://10.10.10.10:4398/api/migpt/v1/health",
  ]);
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;

test("ffmpeg 实际转码：输出 MP3 时长约为剩余时长除以倍速", { skip: !ffmpegAvailable && "本机未安装 ffmpeg" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "migpt-speed-"));
  const source = join(dir, "source.mp3");
  try {
    // 生成 20 秒的测试音频，从第 2 秒开始按 2 倍速转码，应得到约 9 秒。
    const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libmp3lame", "-b:a", "64k", source]);
    assert.equal(generated.status, 0, String(generated.stderr));
    // 与 PodSuite/115 一样支持 Range，ffmpeg 才能读取总时长并按 -ss 定位。
    const sourceBytes = readFileSync(source);
    const sourceServer = createServer((request, response) => {
      const start = Number(String(request.headers.range || "").match(/^bytes=(\d+)-/)?.[1] || 0);
      response.writeHead(start ? 206 : 200, {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Length": sourceBytes.length - start,
        ...(start ? { "Content-Range": `bytes ${start}-${sourceBytes.length - 1}/${sourceBytes.length}` } : {}),
      });
      response.end(sourceBytes.subarray(start));
    });
    await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
    const manager = new SpeedStreamManager({ resolveBaseUrl: async () => "http://127.0.0.1:1" });
    const streamServer = createServer((request, response) => {
      if (!manager.handle(request, response, new URL(request.url || "/", "http://localhost").pathname)) {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => streamServer.listen(0, "127.0.0.1", resolve));
    try {
      const sourceUrl = `http://127.0.0.1:${(sourceServer.address() as AddressInfo).port}/source.mp3`;
      const stream = await manager.create(sourceUrl, 2_000, 2);
      const path = new URL(stream.url).pathname;
      const response = await fetch(`http://127.0.0.1:${(streamServer.address() as AddressInfo).port}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      const output = join(dir, "output.mp3");
      writeFileSync(output, Buffer.from(await response.arrayBuffer()));
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]);
      const duration = Number(String(probe.stdout).trim());
      assert.ok(Math.abs(duration - 9) < 0.5, `转码后时长 ${duration} 秒，预期约 9 秒`);
      assert.equal(manager.sourceDuration(stream.audioId), 20_000);

      const missing = await fetch(`http://127.0.0.1:${(streamServer.address() as AddressInfo).port}/stream/00000000-0000-0000-0000-000000000000.mp3`);
      assert.equal(missing.status, 404);
    } finally {
      sourceServer.close();
      streamServer.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
