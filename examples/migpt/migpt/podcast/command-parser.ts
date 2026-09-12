/** 将中文口语命令转换为可测试的结构化播客意图。 */
export type PodcastIntent =
  | { type: "play"; query?: string; season?: number; episode?: number; fromStart?: boolean }
  | { type: "pause" | "resume" | "stop" | "next" | "previous" | "restart" | "status" }
  | { type: "timer"; minutes: number }
  | { type: "cancelTimer" };

/** 修正常见 ASR 同音误识别，避免“播客”被识别成“博客/波客”。 */
export function normalizePodcastSpeech(input: string) {
  return input
    .replace(/博\s*客|波\s*客|播\s*克|波\s*克/g, "播客")
    // OH2P 常把“播客”识别成“过客”，仅在播放动词后修正，避免误伤节目名。
    .replace(/(播放|播)\s*过客/g, "$1播客")
    .replace(/播\s*客/g, "播客");
}

const number = "(\\d{1,5})";
export const chineseNumber = (value = "") => {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  let total = 0;
  let section = 0;
  let numberValue = 0;
  for (const char of value) {
    if (char in digits) {
      numberValue = digits[char] ?? 0;
      continue;
    }
    const unit = units[char];
    if (!unit) continue;
    if (unit < 10000) {
      section += (numberValue || 1) * unit;
    } else {
      section = (section + numberValue) * unit;
      total += section;
      section = 0;
    }
    numberValue = 0;
  }
  return total + section + numberValue;
};

export function parsePodcastCommand(input: string): PodcastIntent | null {
  const text = normalizePodcastSpeech(input).replace(/[，。！!？?]/g, "").trim();
  if (!text) return null;
  if (/(?:取消|关闭|清除).*(?:定时|计时)/.test(text)) return { type: "cancelTimer" };
  const timer = text.match(/(?:定时|在)?\s*(\d+)\s*(?:分钟|分|小时|个小时)后(?:停止|关闭|结束)/);
  if (timer) {
    const unit = /小时/.test(timer[0]) ? 60 : 1;
    return { type: "timer", minutes: Number(timer[1]) * unit };
  }
  const naturalTimer = text.match(/(?:定时|在)?\s*(半|一|两|二|三|四|五|六|七|八|九|十)\s*(小时|分钟|分)后(?:停止|关闭|结束)/);
  if (naturalTimer) {
    const amount = naturalTimer[1] === "半" ? 0.5 : chineseNumber(naturalTimer[1]);
    const unit = naturalTimer[2]?.startsWith("小时") ? 60 : 1;
    return { type: "timer", minutes: amount * unit };
  }
  if (/(?:暂停|停一下|先停)/.test(text)) return { type: "pause" };
  if (/(?:继续|恢复)(?:播放|播|听)?$/.test(text)) return { type: "resume" };
  if (/(?:停止|结束|停下来|闭嘴|别说了|别讲了|别播|不要播).*(?:播客|播放|听)?/.test(text) && !/下一|上一个/.test(text)) return { type: "stop" };
  if (/(?:下一集|下一个)/.test(text)) return { type: "next" };
  if (/(?:上一集|上一个)/.test(text)) return { type: "previous" };
  if (/(?:从头|重新).*(?:播放|播)/.test(text)) return { type: "restart" };
  if (/(?:播放进度|播到哪|现在播放什么)/.test(text)) return { type: "status" };

  const chineseNumberPattern = "零一二两三四五六七八九十百千万亿";
  const seasonMatch = text.match(new RegExp(`第\\s*(\\d{1,5}|[${chineseNumberPattern}]+)\\s*季`));
  const episodeMatch = text.match(new RegExp(`第\\s*(\\d{1,5}|[${chineseNumberPattern}]+)\\s*[集回章]`));
  const bareEpisode = !episodeMatch && text.match(/(?:播放|播|听).*?\s+(\d{1,5})\s*集/);
  const asksToPlay = /(?:播放|播|听|收听)/.test(text) && /(?:播客|节目|小说|第|集)/.test(text);
  if (!asksToPlay) return null;
  let query = text
    .replace(/^(?:小爱同学[，,]?\s*)?/, "")
    .replace(/^(?:播放|播|听|收听)\s*/, "")
    .replace(/^播客\s*/, "")
    .replace(new RegExp(`第\\s*(?:\\d{1,5}|[${chineseNumberPattern}]+)\\s*季`, "g"), "")
    .replace(new RegExp(`第\\s*(?:\\d{1,5}|[${chineseNumberPattern}]+)\\s*[集回章]`, "g"), "")
    .replace(/\d{1,5}\s*集/g, "")
    .trim();
  if (!query || /^(?:播客|节目)$/.test(query)) query = undefined as unknown as string;
  return {
    type: "play",
    query,
    season: seasonMatch ? chineseNumber(seasonMatch[1]) : undefined,
    episode: episodeMatch ? chineseNumber(episodeMatch[1]) : bareEpisode ? Number(bareEpisode[1]) : undefined,
  };
}
