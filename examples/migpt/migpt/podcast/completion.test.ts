/**
 * OH2P 单节目列表会循环，控制器必须在自然结束时主动停止：没有下一集，
 * 或查到的“下一集”就是当前这集时，都要标记完成并停止，而不是循环重播。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PodcastApiClient } from "./api-client.js";
import { PodcastController, type PodcastSpeaker } from "./controller.js";
import type { Episode, Progress } from "./types.js";

async function playToEnd(nextLookup: "none" | "same") {
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
    // 与真实 PodSuite 一致：按季集精确查询，查不到时返回空列表。
    // "same" 模拟模糊匹配把“第2集”也查成了当前这集。
    async resolveEpisode(_query: string, _season?: number, number?: number) {
      if (number === 1 || nextLookup === "same") return episode;
      return [];
    },
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
}

test("节目自然结束后标记完成并停止播放器", () => playToEnd("none"));

test("查到的下一集就是当前这集时停止播放，不循环重播", () => playToEnd("same"));
