/** 播客控制器在 OH2P 音乐上下文下的断点续播回归测试。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PodcastApiClient } from "./api-client.js";
import { PodcastController, type PodcastSpeaker } from "./controller.js";
import type { Episode, Progress } from "./types.js";

test("只说集数保留全局查询，并在播放器空闲时重新加载断点", async () => {
  const episode: Episode = {
    episode_id: "episode-4",
    podcast_id: "podcast-1",
    podcast_title: "示例播客",
    title: "第4集",
    season: 1,
    episode: 4,
    audio_url: "https://example.com/episode-4.mp3",
    duration_ms: 120_000,
    progress: {
      episode_id: "episode-4",
      position_ms: 60_000,
      duration_ms: 120_000,
      status: "paused",
    },
  };
  const resolved: Array<[string, number | undefined, number | undefined]> = [];
  const saved: Progress[] = [];
  const api = {
    async resolveEpisode(query: string, season?: number, number?: number) {
      resolved.push([query, season, number]);
      return episode;
    },
    async getHistory() { return []; },
    async getCurrentProgress() { return episode.progress; },
    async getEpisode() { return episode; },
    async saveProgress(episodeId: string, progress: Omit<Progress, "episode_id">) {
      const result = { episode_id: episodeId, ...progress };
      saved.push(result);
      episode.progress = result;
      return result;
    },
  } as unknown as PodcastApiClient;

  let status: "playing" | "paused" | "idle" = "idle";
  const playCalls: Array<Record<string, unknown>> = [];
  const seeks: number[] = [];
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(options) {
      playCalls.push(options);
      if (options.url) status = "playing";
      return true;
    },
    async setPlaying(playing = true) { status = playing ? "playing" : "paused"; return true; },
    async stop() { status = "idle"; return true; },
    async getPlaying() { return status; },
    async getPlaybackContext() { return { position: 65_000, duration: 120_000 }; },
    async seek(positionMs) { seeks.push(positionMs); return true; },
  };
  const controller = new PodcastController(api, speaker);

  await controller.handle("播放播客示例播客第4集");
  assert.deepEqual(resolved[0], ["示例播客", undefined, 4]);
  assert.deepEqual(playCalls.at(-1), {
    url: episode.audio_url,
    audioId: episode.episode_id,
    durationMs: episode.duration_ms,
  });
  assert.match(String(playCalls[0]?.text), /继续播放.*第1季第4集/);
  assert.deepEqual(seeks, [60_000]);

  await controller.handle("暂停播客");
  assert.equal(saved.at(-1)?.position_ms, 65_000);
  assert.equal(saved.at(-1)?.status, "paused");

  status = "idle";
  await controller.handle("继续播放");
  assert.equal(playCalls.filter((call) => call.url).length, 2);
  assert.deepEqual(seeks, [60_000, 65_000]);
});

test("切换到下一集前立即保存上一集的位置", async () => {
  const first: Episode = {
    episode_id: "episode-a",
    podcast_id: "podcast-switch",
    podcast_title: "切换测试",
    title: "第1集",
    season: 1,
    episode: 1,
    audio_url: "https://example.com/a.mp3",
    duration_ms: 120_000,
    next_episode_id: "episode-b",
  };
  const second: Episode = {
    ...first,
    episode_id: "episode-b",
    title: "第2集",
    episode: 2,
    audio_url: "https://example.com/b.mp3",
    previous_episode_id: "episode-a",
    next_episode_id: undefined,
  };
  const saved: Progress[] = [];
  const api = {
    async resolveEpisode(_query: string, _season?: number, episode?: number) {
      return episode === 2 ? second : first;
    },
    async getHistory() { return []; },
    async getEpisode(id: string) { return id === second.episode_id ? second : first; },
    async saveProgress(episodeId: string, progress: Omit<Progress, "episode_id">) {
      const result = { episode_id: episodeId, ...progress };
      saved.push(result);
      return result;
    },
  } as unknown as PodcastApiClient;

  let status: "playing" | "paused" | "idle" = "idle";
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(options) { if (options.url) status = "playing"; return true; },
    async setPlaying(playing = true) { status = playing ? "playing" : "paused"; return true; },
    async stop() { status = "idle"; return true; },
    async getPlaying() { return status; },
    async getPlaybackContext() { return { position: 42_000, duration: 120_000 }; },
    async seek() { return true; },
  };

  const controller = new PodcastController(api, speaker);
  await controller.handle("播放播客切换测试第1集");
  await controller.handle("播放下一集");

  assert.equal(saved.some((entry) => entry.episode_id === first.episode_id && entry.status === "paused"), true);
  assert.equal(controller.current?.episode_id, second.episode_id);
});

test("省略播客名时沿用当前节目并切换到指定集", async () => {
  const first: Episode = {
    episode_id: "context-1",
    podcast_id: "context-podcast",
    podcast_title: "上下文播客",
    title: "第1集",
    season: 1,
    episode: 1,
    audio_url: "https://example.com/context-1.mp3",
  };
  const second: Episode = {
    ...first,
    episode_id: "context-2",
    title: "第2集",
    episode: 2,
    audio_url: "https://example.com/context-2.mp3",
  };
  const resolved: Array<[string, number | undefined, number | undefined]> = [];
  const api = {
    async resolveEpisode(query: string, season?: number, episode?: number) {
      resolved.push([query, season, episode]);
      return episode === 2 ? second : first;
    },
    async getHistory() { return []; },
    async saveProgress(episodeId: string, progress: Omit<Progress, "episode_id">) {
      return { episode_id: episodeId, ...progress };
    },
  } as unknown as PodcastApiClient;
  let loadedAudioId = "";
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(options) { if (options.audioId) loadedAudioId = options.audioId; return true; },
    async setPlaying() { return true; },
    async stop() { return true; },
    async getPlaying() { return "playing"; },
    async getPlaybackContext() { return { audio_id: loadedAudioId, position: 0 }; },
    async seek() { return true; },
  };

  const controller = new PodcastController(api, speaker);
  await controller.handle("播放播客上下文播客第1季第1集");
  await controller.handle("播放第2集");

  assert.deepEqual(resolved.at(-1), ["上下文播客", 1, 2]);
  assert.equal(controller.current?.episode_id, second.episode_id);
});

test("PodSuite 暂时不可用时返回可理解的语音提示", async () => {
  const api = {
    async resolveEpisode() { throw new Error("connection refused"); },
  } as unknown as PodcastApiClient;
  const spoken: string[] = [];
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(options) { if (options.text) spoken.push(options.text); return true; },
    async setPlaying() { return true; },
    async stop() { return true; },
    async getPlaying() { return "idle"; },
    async getPlaybackContext() { return {}; },
    async seek() { return true; },
  };

  const controller = new PodcastController(api, speaker);
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await controller.handle("播放播客离线测试第1季第1集");
  } finally {
    console.error = originalError;
  }

  assert.equal(result.handled, true);
  assert.match(result.text || "", /暂时不可用/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(spoken.at(-1) || "", /暂时不可用/);
});

test("唯一的全局集号直接播放，重号时追问季数", async () => {
  const makeEpisode = (season: number): Episode => ({
    episode_id: `duplicate-${season}`,
    podcast_id: "duplicate-podcast",
    podcast_title: "重号节目",
    title: `第${season}季第503集`,
    season,
    episode: 503,
    audio_url: `https://example.com/${season}.mp3`,
  });
  const matches = [makeEpisode(1), makeEpisode(5)];
  const resolved: Array<[number | undefined, number | undefined]> = [];
  const api = {
    async resolveEpisodes(_query: string, season?: number, episode?: number) {
      resolved.push([season, episode]);
      return season ? matches.filter((item) => item.season === season) : matches;
    },
    async resolveEpisode(_query: string, season?: number, episode?: number) {
      resolved.push([season, episode]);
      return season ? matches.find((item) => item.season === season) || [] : matches[0];
    },
    async saveProgress() { return undefined; },
  } as unknown as PodcastApiClient;
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play() { return true; },
    async setPlaying() { return true; },
    async stop() { return true; },
    async getPlaying() { return "playing"; },
    async getPlaybackContext() { return {}; },
    async seek() { return true; },
  };
  const controller = new PodcastController(api, speaker);
  const first = await controller.handle("播放播客重号节目第503集");
  assert.match(first.text || "", /多个第503集/);
  const second = await controller.handle("第5季");
  assert.equal(second.handled, true);
  assert.equal(controller.current?.season, 5);
  assert.deepEqual(resolved.slice(-2), [[undefined, 503], [5, 503]]);
});
