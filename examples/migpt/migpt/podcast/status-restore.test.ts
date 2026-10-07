/** 状态接口恢复“继续播放”将要播放的节目（MiGPT 重启后内存为空的场景）。独立文件以保证模块状态干净。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PodcastApiClient } from "./api-client.js";
import { PodcastController, type PodcastSpeaker } from "./controller.js";
import type { Episode, Progress } from "./types.js";

test("无记录时 30 秒内不重复查询，有未完成记录时恢复为当前节目", async (t) => {
  const progress: Progress = { episode_id: "recent", position_ms: 30_000, duration_ms: 60_000, status: "paused" };
  let currentCalls = 0;
  let hasProgress = false;
  const api = {
    async getCurrentProgress() { currentCalls += 1; return hasProgress ? progress : null; },
    async getEpisode(id: string) {
      return { episode_id: id, podcast_id: "p", podcast_title: "最近播客", title: "第3集", season: 1, episode: 3, audio_url: "https://example.com/3.mp3", duration_ms: 60_000 } as Episode;
    },
  } as unknown as PodcastApiClient;
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play() { return true; },
    async setPlaying() { return true; },
    async stop() { return true; },
    async getPlaying() { return "idle"; },
    async getPlaybackContext() { return {}; },
    async seek() { return true; },
  };
  const controller = new PodcastController(api, speaker);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

  assert.equal(await controller.currentForStatus(), undefined);
  hasProgress = true;
  assert.equal(await controller.currentForStatus(), undefined);
  assert.equal(currentCalls, 1);

  t.mock.timers.setTime(1_000_000 + 30_001);
  const restored = await controller.currentForStatus();
  assert.equal(restored?.episode_id, "recent");
  assert.equal(restored?.progress?.position_ms, 30_000);
  // 恢复后成为当前节目，后续轮询不再请求 PodSuite。
  assert.equal(controller.current?.episode_id, "recent");
  await controller.currentForStatus();
  assert.equal(currentCalls, 2);
});
