/** 中文播客语音命令解析回归测试。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePodcastCommand } from "./command-parser.js";

test("解析播客名称", () => {
  assert.deepEqual(parsePodcastCommand("小爱同学，播放播客剑来"), {
    type: "play",
    query: "剑来",
    season: undefined,
    episode: undefined,
  });
});

test("修正常见的播客同音误识别", () => {
  for (const text of ["播放博客青山", "播放波客青山", "播放播 克青山"]) {
    assert.deepEqual(parsePodcastCommand(text), {
      type: "play", query: "青山", season: undefined, episode: undefined,
    });
  }
  assert.deepEqual(parsePodcastCommand("播放过客剑来"), {
    type: "play", query: "剑来", season: undefined, episode: undefined,
  });
});

test("解析季集并让只说集数时保留未指定季数", () => {
  assert.deepEqual(parsePodcastCommand("播放剑来第3季第4集"), {
    type: "play",
    query: "剑来",
    season: 3,
    episode: 4,
  });
  assert.deepEqual(parsePodcastCommand("播放播客剑来第4集"), {
    type: "play",
    query: "剑来",
    season: undefined,
    episode: 4,
  });
});

test("解析播放器控制和定时停止", () => {
  assert.deepEqual(parsePodcastCommand("暂停播客"), { type: "pause" });
  assert.deepEqual(parsePodcastCommand("让他停下来"), { type: "stop" });
  assert.deepEqual(parsePodcastCommand("闭嘴"), { type: "stop" });
  assert.deepEqual(parsePodcastCommand("30分钟后停止播放"), { type: "timer", minutes: 30 });
  assert.deepEqual(parsePodcastCommand("半小时后停止播放"), { type: "timer", minutes: 30 });
  assert.deepEqual(parsePodcastCommand("一小时后停止播放"), { type: "timer", minutes: 60 });
  assert.deepEqual(parsePodcastCommand("取消定时停止"), { type: "cancelTimer" });
});

test("支持中文数字季集", () => {
  assert.deepEqual(parsePodcastCommand("播放剑来第三季第四集"), {
    type: "play", query: "剑来", season: 3, episode: 4,
  });
  assert.deepEqual(parsePodcastCommand("播放遮天第十二季第一千二百八十集"), {
    type: "play", query: "遮天", season: 12, episode: 1280,
  });
});
