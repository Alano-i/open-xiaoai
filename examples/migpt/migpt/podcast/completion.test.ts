/** OH2P 单节目列表会循环，控制器必须在自然结束时主动停止。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PodcastApiClient } from "./api-client.js";
import { PodcastController, type PodcastSpeaker } from "./controller.js";
import type { Episode, Progress } from "./types.js";

test("节目自然结束后标记完成并停止播放器", async () => {
  const episode: Episode = {
    episode_id: "short-episode",
    podcast_id: "short-podcast",
    podcast_title: "短节目",
    title: "第1集",
    season: 1,
    episode: 1,
    audio_url: "https://example.com/short.mp3",
    duration_ms: 1_000,
  };
  let completed = false;
  const api = {
    async resolveEpisode() { return episode; },
    async getHistory() { return []; },
    async complete(episodeId: string) {
      completed = true;
      return {
        episode_id: episodeId,
        position_ms: 1_000,
        duration_ms: 1_000,
        status: "completed",
      } satisfies Progress;
    },
  } as unknown as PodcastApiClient;

  let startedAt = 0;
  let status: "playing" | "paused" | "idle" = "idle";
  let stopped = false;
  const speaker: PodcastSpeaker = {
    async abortXiaoAI() { return true; },
    async play(options) {
      if (options.url) {
        startedAt = Date.now();
        status = "playing";
      }
      return true;
    },
    async setPlaying() { return true; },
    async stop() { stopped = true; status = "idle"; return true; },
    async getPlaying() { return status; },
    async getPlaybackContext() {
      return {
        audio_id: episode.episode_id,
        position: Math.min(Date.now() - startedAt, 1_000),
        duration: 1_000,
      };
    },
    async seek() { return true; },
  };

  const controller = new PodcastController(api, speaker);
  await controller.handle("播放播客短节目第1季第1集");
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(completed, true);
  assert.equal(stopped, true);
  assert.equal(controller.current?.progress?.status, "completed");
});
