/** MiGPT 播客意图执行器，负责季集询问、续播、播放器控制和进度同步。 */
import { sleep } from "@mi-gpt/utils";
import { chineseNumber, parsePodcastCommand, type PodcastIntent } from "./command-parser.js";
import { PodcastApiClient } from "./api-client.js";
import type { Episode } from "./types.js";

export interface PodcastSpeaker {
  abortXiaoAI(): Promise<boolean>;
  play(options: { text?: string; url?: string; audioId?: string; durationMs?: number | null; blocking?: boolean }): Promise<boolean>;
  setPlaying(playing?: boolean): Promise<boolean>;
  interruptOutput?(): Promise<boolean>;
  stop(): Promise<boolean>;
  getPlaying(sync?: boolean): Promise<"playing" | "paused" | "idle">;
  getPlaybackContext(): Promise<Record<string, unknown>>;
  seek(positionMs: number): Promise<boolean>;
  suppressMicEcho?: (milliseconds?: number, text?: string) => void;
}

export interface ConversationSink {
  append(entry: Record<string, unknown>): void;
}

export interface PodcastHandleResult {
  handled: boolean;
  text?: string;
  /** 是否需要由 MiGPT 主消息队列播报 text；HTTP 控制调用也可忽略。 */
  speak?: boolean;
}

interface LocalState {
  current?: Episode;
  pendingQuery?: string;
  pendingSeason?: number;
  pendingEpisode?: number;
  timerUntil?: number;
}

const state: LocalState = {};
let timer: ReturnType<typeof setTimeout> | undefined;

function contextNumber(context: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = context[name];
    if (typeof value === "number" && Number.isFinite(value)) return normalizePosition(value);
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
      const numeric = Number(value);
      return normalizePosition(numeric);
    }
  }
  return undefined;
}

function normalizePosition(value: number) {
  return process.env.MIGPT_POSITION_UNIT === "s" ? Math.round(value * 1000) : Math.round(value);
}

export class PodcastController {
  private readonly api: PodcastApiClient;
  private completionTimer?: ReturnType<typeof setTimeout>;
  private completionGeneration = 0;
  private speechTail: Promise<void> = Promise.resolve();
  private speechGeneration = 0;

  constructor(
    api: PodcastApiClient,
    private readonly speaker: PodcastSpeaker,
    private readonly conversations?: ConversationSink,
  ) {
    this.api = api;
    // 播放中每 15 秒上报一次位置，异常断电也能在最近位置续播。
    const progressTimer = setInterval(() => {
      void this.speaker.getPlaying(true).then((status) => {
        if (status === "playing") {
          void this.saveCurrentProgress("playing").then((progress) => {
            if (progress?.duration_ms) this.scheduleCompletion(progress.position_ms, progress.duration_ms);
          });
        }
      });
    }, 15_000);
    progressTimer.unref();
  }

  get current() { return state.current; }
  get timerUntil() { return state.timerUntil; }

  updateApi(config: { baseUrl: string; token?: string }) {
    this.api.updateConfig(config);
  }

  async history(limit = 100) {
    const entries = (await this.api.getHistory()).slice(0, limit);
    return Promise.all(entries.map(async (entry) => {
      const episode = await this.api.getEpisode(entry.episode_id).catch(() => undefined);
      return { ...entry, episode };
    }));
  }

  /**
   * 服务重启后从 PodSuite 的最近一条未完成记录恢复当前节目。
   * 当前节目只保存在内存中，进度则由 PodSuite 持久化，因此不能只依赖 state.current。
   */
  private async ensureCurrent() {
    if (state.current) return state.current;
    const progress = await this.api.getCurrentProgress().catch(() => null);
    if (!progress || progress.status === "completed") return undefined;
    const episode = await this.api.getEpisode(progress.episode_id).catch(() => undefined);
    if (!episode) return undefined;
    episode.progress = progress;
    state.current = episode;
    return episode;
  }

  async handle(input: string): Promise<PodcastHandleResult> {
    try {
      const intent = parsePodcastCommand(input);
      if (!intent && state.pendingQuery) return await this.handlePending(input);
      // “播放音乐/听音乐”是原生小爱音乐服务指令，不应拿“音乐”作为
      // 播客标题去 PodSuite 模糊查询；否则可能误命中名为“音乐”的播客，
      // 结果变成播放播客而不是转发给原生小爱。
      if (/^(?:播放|播|听|收听)\s*(?:音乐|歌曲|歌)\s*$/.test(input.trim())) {
        return { handled: false };
      }
      // 对“播放剑来”这类未明确说出“播客”的表达，先向 PodSuite 查询。
      // 查不到节目时返回 handled=false，继续交给原生小爱处理音乐等服务，
      // 避免必须说“播放播客”才能点播，同时不会劫持普通音乐命令。
      if (!intent) {
        const genericPlay = input.match(/^(?:播放|播|听|收听)\s*(.+)$/);
        if (genericPlay?.[1]) {
          const result = await this.api.resolveEpisode(genericPlay[1].trim(), 1).catch(() => []);
          if (result && !Array.isArray(result)) return this.startEpisode(result);
        }
      }
      if (!intent) return { handled: false };
      // 只屏蔽与刚处理的命令完全相同的回声，不影响用户紧接着回答季集或询问天气。
      this.speaker.suppressMicEcho?.(20000, input);
      this.conversations?.append({ type: "intent", input, intent, at: new Date().toISOString() });
      switch (intent.type) {
        case "play": return await this.play(intent);
        case "pause": return await this.pause();
        case "resume": return await this.resume();
        case "stop": return await this.stop();
        case "next": return await this.adjacent(1);
        case "previous": return await this.adjacent(-1);
        case "restart": return await this.restart();
        case "status": return await this.status();
        case "timer": return await this.setTimer(intent.minutes);
        case "cancelTimer": return await this.cancelTimer();
      }
    } catch (error) {
      console.error("❌ 播客指令处理失败", error);
      return this.reply("播客服务暂时不可用，请稍后再试。", true);
    }
  }

  /** 取消尚未播出的播客提示，避免唤醒/新指令后又把旧提示播出来。 */
  cancelSpeech() {
    this.speechGeneration += 1;
  }

  private async handlePending(input: string) {
    const numberPattern = "\\d{1,5}|[零一二两三四五六七八九十百千万亿]+";
    const seasonMatch = input.match(new RegExp(`第\\s*(${numberPattern})\\s*季`));
    const episodeMatch = input.match(new RegExp(`第\\s*(${numberPattern})\\s*[集回章]`)) || input.match(/(\d{1,5})\s*集/);
    if (!episodeMatch) {
      // 等待季集时，非季集指令（如“天气”“现在几点”）不能被播客状态吞掉，
      // 交回上层路由给原生小爱处理。
      if (!seasonMatch) {
        state.pendingQuery = undefined;
        state.pendingSeason = undefined;
        state.pendingEpisode = undefined;
        return { handled: false };
      }
      if (state.pendingEpisode !== undefined) {
        const season = chineseNumber(seasonMatch[1]);
        const episode = state.pendingEpisode;
        const query = state.pendingQuery;
        state.pendingQuery = undefined;
        state.pendingSeason = undefined;
        state.pendingEpisode = undefined;
        return this.play({ type: "play", query, season, episode });
      }
      return { handled: true, text: "请告诉我第几集，例如第3季第4集。" };
    }
    const season = seasonMatch ? chineseNumber(seasonMatch[1]) : state.pendingSeason;
    const episode = episodeMatch ? chineseNumber(episodeMatch[1]) : state.pendingEpisode;
    const query = state.pendingQuery;
    state.pendingQuery = undefined;
    state.pendingSeason = undefined;
    state.pendingEpisode = undefined;
    return this.play({ type: "play", query, season, episode });
  }

  private async play(intent: Extract<PodcastIntent, { type: "play" }>) {
    let episode: Episode | undefined;
    if (intent.query) {
      // 未指定季时保留全局集号查询；只有匹配到多个同号节目才追问季数。
      const requestedSeason = intent.season;
      let matches: Episode[];
      if (intent.episode !== undefined && requestedSeason === undefined && typeof this.api.resolveEpisodes === "function") {
        matches = await this.api.resolveEpisodes(intent.query, undefined, intent.episode);
      } else {
        const result = await this.api.resolveEpisode(intent.query, requestedSeason, intent.episode);
        matches = result && !Array.isArray(result) ? [result] : [];
      }
      // 未指定季数时，只有同一集号确实对应多个节目才追问季数；唯一结果（例如全局编号 503）直接播放。
      if (matches.length === 1) episode = matches[0];
      const resolvedId = episode?.episode_id;
      if (matches.length > 1 && intent.episode !== undefined && requestedSeason === undefined) {
        state.pendingQuery = intent.query;
        state.pendingEpisode = intent.episode;
        return this.reply(`找到多个第${intent.episode}集，请告诉我第几季。`);
      }
      if (!intent.season && !intent.episode) {
        const query = intent.query!;
        const reusedCurrent = Boolean(state.current && state.current.podcast_title.includes(query) && state.current.progress?.status !== "completed");
        if (reusedCurrent) {
          episode = state.current;
        }
        // 仅说节目名时优先寻找该节目最近未完成的记录，而不是误播第一集。
        const history = episode ? [] : await this.api.getHistory().catch(() => []);
        // 详情接口在远程 PodSuite 上可能需要数秒，不能逐条串行查询（几十条
        // 历史记录会把一次“播放播客”拖到几十秒）。只检查少量最近记录，且
        // 有严格超时；找不到时直接询问季集，保证语音先响应。
        // 只检查最近一条记录，避免一次语音请求并发触发大量 RSS 解析任务。
        const lookup = Promise.all(history.slice(0, 1).map(async (entry) => {
          if (entry.status === "completed") return undefined;
          try { return await this.api.getEpisode(entry.episode_id); }
          catch (_) { return undefined; }
        }));
        // 详情接口可能因 RSS 解析而变慢；语音交互不能等待它。超时后先询问
        // 季集，后续用户可直接指定集数，避免“播放播客”卡住几十秒。
        const candidates = await Promise.race([
          lookup,
          new Promise<(Episode | undefined)[]>((resolve) => setTimeout(() => resolve([]), 1200)),
        ]);
        const historicalEpisode = candidates.find((candidate) => candidate && (
          candidate.podcast_title === query || candidate.podcast_title.includes(query)
        ));
        if (historicalEpisode) episode = historicalEpisode;
        if (!episode || (!reusedCurrent && !historicalEpisode && episode.episode_id === resolvedId)) {
          state.pendingQuery = intent.query;
          state.pendingEpisode = undefined;
          return this.reply("你想听第几集？");
        }
      }
    } else {
      const current = await this.ensureCurrent();
      if (current && (intent.season !== undefined || intent.episode !== undefined)) {
        // 未写播客名时沿用当前节目；指定集号时优先使用用户明确给出的季数。
        const requestedSeason = intent.season ?? (intent.episode !== undefined ? 1 : current.season);
        const result = await this.api.resolveEpisode(current.podcast_title, requestedSeason, intent.episode);
        if (result && !Array.isArray(result)) episode = result;
      } else {
        episode = current;
      }
    }
    if (!episode && intent.query) {
      const result = await this.api.resolveEpisode(intent.query, intent.season ?? 1, intent.episode);
      if (result && !Array.isArray(result)) episode = result;
    }
    if (!episode) return this.reply("没有找到这个播客，请检查播客名称或季集。", true);
    return this.startEpisode(episode, intent.fromStart);
  }

  private async startEpisode(episode: Episode, fromStart = false, announce = true) {
    // 切换节目之前立即保存旧节目的位置，避免用户连续说“下一集”或直接点播
    // 时还没等到 15 秒进度上报就丢失断点。
    if (state.current && state.current.episode_id !== episode.episode_id) {
      // 进度上报不应阻塞下一集的播放；网络异常时也不能让语音指令卡住。
      void this.saveCurrentProgress("paused");
    }
    this.cancelCompletion();
    state.current = episode;
    const position = fromStart || episode.progress?.status === "completed"
      ? 0
      : Number(episode.progress?.position_ms || 0);
    if (announce) {
      await this.enqueueSpeak(`好的，${position > 0 ? "继续播放" : "正在播放"}《${episode.podcast_title}》第${episode.season}季第${episode.episode}集。`);
    }
    const played = await this.speaker.play({
      url: episode.audio_url,
      audioId: episode.episode_id,
      durationMs: episode.duration_ms,
    });
    if (!played) return this.reply("音频播放失败，请检查音箱和播客地址。", true);
    // player_play_music 返回时媒体可能还未装载；等待目标 audio_id 出现后再 seek。
    // 新节目从头播放无需等待播放器上下文；只有续播时才需要轮询并 seek。
    const context = position > 0 ? await this.preparePlayback(episode.episode_id, position) : undefined;
    const reportedDuration = contextNumber(context || {}, ["duration_ms", "duration", "audio_length", "length"]);
    const duration = reportedDuration && reportedDuration > 0 ? reportedDuration : episode.duration_ms ?? undefined;
    if (duration) this.scheduleCompletion(position, duration);
    return { handled: true };
  }

  private async preparePlayback(episodeId: string, positionMs: number) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      const context = await this.speaker.getPlaybackContext().catch(() => ({} as Record<string, unknown>));
      const audioId = String(context.audio_id || context.audioId || "");
      const loaded = audioId === episodeId || (!audioId && ["position", "position_ms", "duration"].some((key) => context[key] !== undefined));
      if (!loaded) continue;
      if (positionMs <= 0 || await this.speaker.seek(positionMs).catch(() => false)) return context;
    }
    return undefined;
  }

  private async pause() {
    await this.ensureCurrent();
    await this.saveCurrentProgress("paused");
    await this.speaker.setPlaying(false);
    this.cancelCompletion();
    return this.reply("已暂停。", false);
  }

  /** 唤醒词触发时先暂停并保存断点，让用户能在安静状态下说完指令。 */
  async pauseForWake() {
    this.cancelCompletion();
    // 先暂停本地播放器，再做任何网络请求；ensureCurrent 或保存进度较慢时
    // 也不能让背景音继续覆盖用户正在说的指令。
    const paused = await this.speaker.setPlaying(false);
    // 进度保存放到后台，不能让 PodSuite 的网络延迟阻塞最终 ASR。否则
    // 用户说“停止”时虽然已经静音，消息队列却会一直等待远程接口，导致
    // 停止确认和后续指令看起来像失效。
    void this.ensureCurrent()
      .then(() => this.saveCurrentProgress("paused"))
      .catch((error) => console.warn("⚠️ 唤醒暂停进度保存失败", error));
    return paused;
  }

  private async resume() {
    await this.ensureCurrent();
    if (!state.current || state.current.progress?.status === "completed") return this.reply("当前没有可继续播放的播客。", true);
    const status = await this.speaker.getPlaying(true);
    if (status === "idle") {
      return this.play({
        type: "play",
        query: state.current.podcast_title,
        season: state.current.season,
        episode: state.current.episode,
      });
    }
    await this.speaker.setPlaying(true);
    const progress = await this.saveCurrentProgress("playing");
    if (progress?.duration_ms) this.scheduleCompletion(progress.position_ms, progress.duration_ms);
    return this.reply("继续播放。", false);
  }

  private async stop() {
    // 停止命令必须先让音箱静音，不能把网络保存进度放在前面导致旧音频
    // 继续播放数秒。上下文和停止请求并发发出，尽量保留停止前的断点。
    const contextPromise = this.speaker.getPlaybackContext().catch(() => ({} as Record<string, unknown>));
    const stopPromise = this.speaker.stop();
    await Promise.all([contextPromise, stopPromise]);
    await this.ensureCurrent();
    await this.saveCurrentProgress("stopped", await contextPromise);
    this.cancelCompletion();
    return this.reply("已停止播放。", false);
  }

  private async restart() {
    await this.ensureCurrent();
    if (!state.current) return this.reply("当前没有正在播放的播客。", true);
    return this.play({ type: "play", query: state.current.podcast_title, season: state.current.season, episode: state.current.episode, fromStart: true });
  }

  private async adjacent(direction: 1 | -1) {
    await this.ensureCurrent();
    if (!state.current) return this.reply("当前没有正在播放的播客。", true);
    const current = state.current;
    // 优先使用搜索接口按季集获取目标节目，避免 getEpisode(id) 在远程服务上
    // 约 5 秒的详情查询延迟；若节目编号不连续，再回退到 next/previous id。
    const targetEpisode = current.episode + direction;
    const searched = await this.api.resolveEpisode(current.podcast_title, current.season, targetEpisode).catch(() => []);
    let episode = !Array.isArray(searched) ? searched : undefined;
    if (!episode) {
      const nextId = direction > 0 ? current.next_episode_id : current.previous_episode_id;
      if (!nextId) return this.reply(direction > 0 ? "已经是最后一集了。" : "已经是第一集了。", true);
      episode = await this.api.getEpisode(nextId);
    }
    return this.startEpisode(episode, false, false);
  }

  private async status() {
    await this.ensureCurrent();
    const player = await this.speaker.getPlaying(true);
    const title = state.current ? `《${state.current.podcast_title}》第${state.current.season}季第${state.current.episode}集` : "没有播客";
    return this.reply(`${title}，当前${player === "playing" ? "正在播放" : player === "paused" ? "已暂停" : "未播放"}。`);
  }

  private async setTimer(minutes: number) {
    if (minutes <= 0) return this.reply("定时时间必须大于零。", true);
    if (timer) clearTimeout(timer);
    state.timerUntil = Date.now() + minutes * 60_000;
    timer = setTimeout(async () => {
      await this.saveCurrentProgress("timer_stopped");
      this.cancelCompletion();
      await this.speaker.stop();
      state.timerUntil = undefined;
      timer = undefined;
    }, minutes * 60_000);
    return this.reply(`好的，${minutes}分钟后停止播放。`);
  }

  private async cancelTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    state.timerUntil = undefined;
    return this.reply("已取消定时停止。", true);
  }

  private async saveCurrentProgress(status: string, context?: Record<string, unknown>) {
    const current = state.current;
    if (!current) return;
    const playbackContext = context || await this.speaker.getPlaybackContext().catch(() => ({}));
    const position = contextNumber(playbackContext, ["position_ms", "position", "audio_pos", "pos"]) ?? Number(current.progress?.position_ms || 0);
    const reportedDuration = contextNumber(playbackContext, ["duration_ms", "duration", "audio_length", "length"]);
    const duration = reportedDuration && reportedDuration > 0 ? reportedDuration : current.duration_ms ?? undefined;
    const progress = await this.api.saveProgress(current.episode_id, {
      position_ms: position,
      duration_ms: duration,
      status,
      device_id: process.env.MIGPT_DEVICE_ID || "",
    }).catch(() => undefined);
    if (progress && state.current?.episode_id === current.episode_id) state.current.progress = progress;
    return progress;
  }

  private cancelCompletion() {
    this.completionGeneration += 1;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = undefined;
  }

  private scheduleCompletion(positionMs: number, durationMs: number) {
    this.cancelCompletion();
    if (durationMs <= 0 || positionMs >= durationMs) return;
    const generation = this.completionGeneration;
    const delay = Math.max(250, durationMs - positionMs - 2_000);
    this.completionTimer = setTimeout(() => void this.checkCompletion(generation, positionMs), delay);
    this.completionTimer.unref();
  }

  private async checkCompletion(generation: number, previousPosition: number) {
    if (generation !== this.completionGeneration || !state.current) return;
    const status = await this.speaker.getPlaying(true);
    const context = await this.speaker.getPlaybackContext().catch(() => ({} as Record<string, unknown>));
    const position = contextNumber(context, ["position_ms", "position", "audio_pos", "pos"]);
    const reportedDuration = contextNumber(context, ["duration_ms", "duration", "audio_length", "length"]);
    const duration = reportedDuration && reportedDuration > 0 ? reportedDuration : state.current.duration_ms ?? undefined;
    const naturallyFinished = Boolean(duration && previousPosition > duration * 0.8 && (
      status === "idle" || position === undefined || position >= duration - 150 || position + 1_000 < previousPosition
    ));
    if (naturallyFinished) {
      const progress = await this.api.complete(state.current.episode_id, process.env.MIGPT_DEVICE_ID || "").catch(() => undefined);
      if (progress) state.current.progress = progress;
      this.cancelCompletion();
      // 设置了定时停止时，当前节目播完即停，不跨集继续播放；定时器仍由
      // setTimer 管理。未设置定时器则无缝衔接下一集，直到 PodSuite 找不到
      // 后续节目为止。pause/stop 会提前 cancelCompletion，因此不会误触发。
      if (!state.timerUntil) {
        const advanced = await this.advanceAfterCompletion(state.current);
        if (advanced) return;
      }
      if (status !== "idle") await this.speaker.stop();
      return;
    }
    if (status !== "playing") return;
    if (generation !== this.completionGeneration) return;
    this.completionTimer = setTimeout(
      () => void this.checkCompletion(generation, position ?? previousPosition),
      100,
    );
    this.completionTimer.unref();
  }

  /** 自然播放结束后的静默自动续播，不播报“下一集”提示音，避免集与集之间断音。 */
  private async advanceAfterCompletion(current: Episode) {
    const targetEpisode = current.episode + 1;
    const searched = await this.api
      .resolveEpisode(current.podcast_title, current.season, targetEpisode)
      .catch(() => []);
    let next = !Array.isArray(searched) ? searched : undefined;
    if (!next && current.next_episode_id) {
      next = await this.api.getEpisode(current.next_episode_id).catch(() => undefined);
    }
    if (!next) return false;
    console.log("▶️ 当前节目已播完，自动播放下一集", {
      podcast: current.podcast_title,
      from: `${current.season}-${current.episode}`,
      to: `${next.season}-${next.episode}`,
    });
    const played = await this.startEpisode(next, false, false);
    return played.handled && state.current?.episode_id === next.episode_id;
  }

  /** 实际执行一条播客提示音；调用方必须通过 enqueueSpeak 串行化。 */
  private async speakNow(text: string) {
    this.conversations?.append({ type: "assistant", text, source: "podcast", at: new Date().toISOString() });
    await this.speaker.abortXiaoAI().catch(() => false);
    await this.speaker.play({ text, blocking: true });
  }

  private enqueueSpeak(text: string) {
    const generation = this.speechGeneration;
    const job = this.speechTail.then(async () => {
      if (generation !== this.speechGeneration) return;
      await this.speakNow(text);
    });
    this.speechTail = job.catch(() => undefined);
    return job;
  }

  private reply(text: string, speak = true) {
    // 不在这里启动后台 TTS。handle() 可能由多个 ASR/HTTP 请求调用，后台
    // 播放会绕过 MiGPT 的消息队列，导致提示音与播客或 AI 同时播放。由上层
    // 将需要播报的文本作为普通 response 串行播放。
    this.conversations?.append({ type: "assistant", text, source: "podcast", at: new Date().toISOString() });
    if (speak) void this.enqueueSpeak(text);
    return { handled: true, text, speak };
  }
}
