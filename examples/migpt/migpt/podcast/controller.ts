/** MiGPT 播客意图执行器，负责季集询问、续播、播放器控制和进度同步。 */
import { sleep } from "@mi-gpt/utils";
import { chineseNumber, parsePodcastCommand, type PodcastIntent } from "./command-parser.js";
import { PodcastApiClient } from "./api-client.js";
import { PLAYBACK_SPEEDS, isSupportedSpeed, type SpeedStreamManager } from "./speed-stream.js";
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
  /** 管理页调节音量用；播客控制流程本身不依赖。 */
  setVolume?(volume: number): Promise<boolean>;
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
  /** 指令未能执行（找不到节目、播放失败等）。管理页据此显示警告而不是成功提示。 */
  failed?: boolean;
}

/**
 * 当前正在播放的倍速流。音箱上报的位置是流内时间，
 * 原始位置 = baseMs + 流内位置 × speed；原速直连播放时为 undefined。
 */
interface ActiveStream {
  audioId: string;
  speed: number;
  baseMs: number;
}

export interface PodcastControllerOptions {
  /** 倍速转码服务；未提供时只能原速播放。 */
  streams?: SpeedStreamManager;
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

/** 开始播放（含跳转、切换倍速）后，播放器装载新音频期间仍会上报旧音频，完播检测在此时间内继续等待。 */
const PLAYBACK_LOAD_WINDOW_MS = 10_000;
/** 倍速播放时目标位置距结尾不足这么多毫秒就直接按播完处理：ffmpeg 从结尾转码几乎没有内容，播放器会拿不到音频。 */
const STREAM_END_MARGIN_MS = 2_000;

/** 断点距结尾不足这么多毫秒时视为已播完，续播改为从头开始（从结尾续播听不到内容，倍速流还会转码出空音频）。 */
const END_RESUME_MARGIN_MS = 5_000;

/** 续播的起始位置：已完成或断点已在结尾附近时从头播放。 */
function resumePosition(episode: Episode) {
  const progress = episode.progress;
  if (!progress || progress.status === "completed") return 0;
  const position = Number(progress.position_ms || 0);
  const duration = Number(episode.duration_ms || progress.duration_ms || 0);
  return duration > 0 && position >= duration - END_RESUME_MARGIN_MS ? 0 : position;
}

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
  readonly streams?: SpeedStreamManager;
  /** 用户选择的倍速，对之后开始的每一次播放生效。 */
  private desiredSpeed = 1;
  private activeStream?: ActiveStream;
  /**
   * 暂停期间切换了倍速或拖动了进度：转码流无法原地变速或跳转，
   * 继续播放时需要从 PodSuite 保存的断点重新拉流。
   */
  private restartOnResume = false;
  /** 最近一次下发播放的时间，用于判断播放器是否仍在装载新音频。 */
  private playStartedAt = 0;

  constructor(
    api: PodcastApiClient,
    private readonly speaker: PodcastSpeaker,
    private readonly conversations?: ConversationSink,
    options: PodcastControllerOptions = {},
  ) {
    this.api = api;
    this.streams = options.streams;
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

  private restoreCheckedAt = 0;

  /**
   * 状态接口使用的当前节目。MiGPT 重启后内存中没有当前节目，但“继续播放”会通过 ensureCurrent
   * 从 PodSuite 最近一条未完成记录恢复并续播；这里用同一逻辑恢复，让管理页显示的就是点播放键
   * 会播的那一集。状态每 5 秒轮询一次：最多等待 2 秒，没有记录时 30 秒内不重复查询 PodSuite。
   */
  async currentForStatus() {
    if (state.current) return state.current;
    if (Date.now() - this.restoreCheckedAt < 30_000) return undefined;
    this.restoreCheckedAt = Date.now();
    return Promise.race([
      this.ensureCurrent().catch(() => undefined),
      sleep(2_000).then(() => undefined),
    ]);
  }
  get timerUntil() { return state.timerUntil; }

  get speed() { return this.desiredSpeed; }

  /** 音箱里当前这段音频的实际倍速：原速直连（含倍速不可用时的回退、MiGPT 重启前加载的音频）为 1。 */
  private get playingSpeed() { return this.activeStream?.speed ?? 1; }

  /**
   * 启动时恢复 config.json 中保存的倍速，不影响正在进行的播放。
   * 旧版本的档位（如 1.25、1.33、1.75）已不在列表中，换成最接近的档位。
   */
  restoreSpeed(speed: unknown) {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return;
    this.desiredSpeed = PLAYBACK_SPEEDS.reduce((best, item) => (
      Math.abs(item - speed) < Math.abs(best - speed) ? item : best
    ), PLAYBACK_SPEEDS[0] as number);
  }

  /**
   * 切换倍速。播放中立即从当前位置按新倍速重新拉流；暂停时只记录，
   * 继续播放时再生效（见 resume）；空闲时对下一次播放生效。
   * 设置值与音箱里实际倍速不一致时（如 MiGPT 重启后），重选同一档位也会重新拉流。
   */
  async setSpeed(speed: number): Promise<PodcastHandleResult & { speed: number }> {
    if (!isSupportedSpeed(speed)) return { ...this.fail("不支持该倍速。", false), speed: this.desiredSpeed };
    if (speed === this.desiredSpeed && speed === this.playingSpeed) return { handled: true, speed };
    this.desiredSpeed = speed;
    const current = state.current;
    if (!current) return { handled: true, speed };
    const status = await this.speaker.getPlaying(true);
    if (status !== "playing") return { handled: true, speed };
    const progress = await this.saveCurrentProgress("playing");
    const position = progress?.position_ms ?? Number(current.progress?.position_ms || 0);
    const result = await this.playFrom(current, position);
    return { ...result, speed };
  }

  /**
   * 状态接口返回的播放器上下文：倍速播放时把流内位置、时长换算成原始音频时间，
   * 管理页无需关心是否经过转码。
   */
  playbackForStatus(context: Record<string, unknown>) {
    const current = state.current;
    if (!current || (!this.activeStream && !this.restartOnResume && !this.isForeignAudio(context))) return context;
    // 播放器里是别的音频（或新流尚未装载）时显示 PodSuite 保存的断点。
    const position = this.restartOnResume
      ? Number(current.progress?.position_ms || 0)
      : this.positionFrom(context) ?? Number(current.progress?.position_ms || 0);
    const duration = this.durationFrom(context, current);
    return { ...context, position_ms: position, duration_ms: duration ?? null };
  }

  updateApi(config: { baseUrl: string; token?: string }) {
    this.api.updateConfig(config);
  }

  /** 管理页联想与待播清单直接读取 PodSuite，MiGPT 只负责转发和鉴权。 */
  suggestPodcasts(query: string) {
    return this.api.suggestPodcasts(query);
  }

  upcomingEpisodes(episodeId: string, limit?: number) {
    return this.api.getUpcoming(episodeId, limit);
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
      return this.fail("播客服务暂时不可用，请稍后再试。");
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
    if (!episode) return this.fail("没有找到这个播客，请检查播客名称或季集。");
    return this.startEpisode(episode, intent.fromStart);
  }

  /**
   * 管理页“待播清单”按单集 ID 精确点播。按名称点播会把“斗罗大陆”同时匹配到
   * 斗罗大陆 2/3/4，因此网页已知具体节目时不能再走名称解析。
   */
  async playEpisode(episodeId: string): Promise<PodcastHandleResult> {
    try {
      const episode = await this.api.getEpisode(episodeId).catch(() => undefined);
      if (!episode) return this.fail("没有找到这一集，可能已从 PodSuite 移除。");
      state.pendingQuery = undefined;
      state.pendingSeason = undefined;
      state.pendingEpisode = undefined;
      return await this.startEpisode(episode);
    } catch (error) {
      console.error("❌ 按节目 ID 播放失败", error);
      return this.fail("播放失败，请稍后重试。");
    }
  }

  private async startEpisode(episode: Episode, fromStart = false, announce = true) {
    // 切换节目之前立即保存旧节目的位置，避免用户连续说“下一集”或直接点播
    // 时还没等到 15 秒进度上报就丢失断点。
    // 已标记完成的节目（自然播完后自动下一集）不能再保存：播放器此时停在结尾，
    // 会把“已完成”覆盖成结尾处的“暂停”，之后按上一集就会从结尾续播而播不出声音。
    if (state.current && state.current.episode_id !== episode.episode_id && state.current.progress?.status !== "completed") {
      // 进度上报不应阻塞下一集的播放；网络异常时也不能让语音指令卡住。
      void this.saveCurrentProgress("paused");
    }
    this.cancelCompletion();
    state.current = episode;
    const position = fromStart ? 0 : resumePosition(episode);
    if (announce) {
      await this.enqueueSpeak(`好的，${position > 0 ? "继续播放" : "正在播放"}《${episode.podcast_title}》第${episode.season}季第${episode.episode}集。`);
    }
    return this.playFrom(episode, position);
  }

  /**
   * 从原始音频的 position 处开始播放 episode。倍速不为 1 时播放 ffmpeg 转码流
   * （流本身就从 position 开始，不需要 seek）；倍速流不可用时回退到原速，
   * 播放照常进行，只在结果中提示原因。
   */
  private async playFrom(episode: Episode, position: number): Promise<PodcastHandleResult> {
    this.cancelCompletion();
    this.restartOnResume = false;
    this.playStartedAt = Date.now();
    const speed = this.desiredSpeed;
    let fallbackReason: string | undefined;
    const sourceDuration = this.durationFrom({}, episode);
    if (speed !== 1 && this.streams && sourceDuration && position >= sourceDuration - STREAM_END_MARGIN_MS) {
      // 拖到结尾（或在最后两秒切换倍速）：按播完处理并进入下一集。
      await this.finishEpisode(episode, await this.speaker.getPlaying(true));
      return { handled: true };
    }
    if (speed !== 1 && this.streams) {
      const stream = await this.streams.create(episode.audio_url, position, speed).catch((error: unknown) => {
        fallbackReason = error instanceof Error ? error.message : String(error);
        console.warn("⚠️ 倍速流创建失败，改为原速播放", fallbackReason);
        return undefined;
      });
      if (stream) {
        // 先登记新流再下发播放：期间到达的旧流位置因 audio_id 不同会被忽略。
        this.activeStream = { audioId: stream.audioId, speed, baseMs: position };
        const total = episode.duration_ms ?? undefined;
        const played = await this.speaker.play({
          url: stream.url,
          audioId: stream.audioId,
          durationMs: total ? Math.max(0, (total - position) / speed) : null,
        });
        if (!played) return this.fail("音频播放失败，请检查音箱和播客地址。");
        if (total) this.scheduleCompletion(position, total);
        return { handled: true };
      }
    } else if (speed !== 1) {
      fallbackReason = "MiGPT 未启用倍速转码";
    }
    this.activeStream = undefined;
    const played = await this.speaker.play({
      url: episode.audio_url,
      audioId: episode.episode_id,
      durationMs: episode.duration_ms,
    });
    if (!played) return this.fail("音频播放失败，请检查音箱和播客地址。");
    // player_play_music 返回时媒体可能还未装载；等待目标 audio_id 出现后再 seek。
    // 新节目从头播放无需等待播放器上下文；只有续播时才需要轮询并 seek。
    const context = position > 0 ? await this.preparePlayback(episode.episode_id, position) : undefined;
    const reportedDuration = contextNumber(context || {}, ["duration_ms", "duration", "audio_length", "length"]);
    const duration = reportedDuration && reportedDuration > 0 ? reportedDuration : episode.duration_ms ?? undefined;
    if (duration) this.scheduleCompletion(position, duration);
    return fallbackReason
      ? { handled: true, failed: true, text: `${fallbackReason}，已按原速播放。` }
      : { handled: true };
  }

  /**
   * 播放器里是不是别的音频：原生小爱的音乐、其他 URL，或新节目/新倍速流尚未装载时残留的上一段音频。
   * 这时上下文里的位置和时长都与当前播客无关，不能用来保存断点或判断完播，
   * 否则会把别的音频的进度写进当前播客。固件未上报 audio_id 时无法判断，按当前播客处理。
   */
  private isForeignAudio(
    context: Record<string, unknown>,
    episode = state.current,
    stream = this.activeStream,
  ) {
    const audioId = String(context.audio_id || context.audioId || "");
    const expected = stream?.audioId ?? episode?.episode_id;
    return Boolean(audioId && expected && audioId !== expected);
  }

  /**
   * 播放器上下文中的原始音频位置；播放器里是别的音频时返回 undefined。
   * episode/stream 默认取当前状态；异步保存进度时须传入调用时的值，避免切集后错判。
   */
  private positionFrom(context: Record<string, unknown>, episode = state.current, stream = this.activeStream) {
    if (this.isForeignAudio(context, episode, stream)) return undefined;
    const raw = contextNumber(context, ["position_ms", "position", "audio_pos", "pos"]);
    if (!stream || raw === undefined) return raw;
    return Math.round(stream.baseMs + raw * stream.speed);
  }

  /** 原始音频总时长。倍速流的时长是转码后的流长度，不能直接使用，改用节目元数据或 ffmpeg 解析值。 */
  private durationFrom(context: Record<string, unknown>, episode: Episode, stream = this.activeStream) {
    if (stream) return episode.duration_ms ?? this.streams?.sourceDuration(stream.audioId) ?? undefined;
    if (this.isForeignAudio(context, episode, stream)) return episode.duration_ms ?? undefined;
    const reported = contextNumber(context, ["duration_ms", "duration", "audio_length", "length"]);
    return reported && reported > 0 ? reported : episode.duration_ms ?? undefined;
  }

  /**
   * 网页拖动进度条后的跳转。直接调用 speaker.seek 不会更新完播检测，
   * 拖到结尾附近时会错过自动下一集；这里跳转后保存断点并按新位置重新计时。
   */
  async seek(positionMs: number) {
    const target = Math.max(0, Math.round(positionMs));
    const current = state.current;
    if (current && (this.activeStream || this.restartOnResume)) return this.seekStream(current, target);
    const success = await this.speaker.seek(target).catch(() => false);
    if (!success || !current) return { success };
    const status = await this.speaker.getPlaying(true);
    const progress = await this.saveCurrentProgress(status === "playing" ? "playing" : "paused");
    const duration = progress?.duration_ms ?? current.duration_ms;
    if (status === "playing" && duration) this.scheduleCompletion(target, duration);
    else this.cancelCompletion();
    return { success };
  }

  /** 倍速流无法按字节跳转：播放中从目标位置重新拉流，暂停时记录断点、继续播放时生效。 */
  private async seekStream(current: Episode, target: number) {
    const status = await this.speaker.getPlaying(true);
    if (status === "playing") {
      const result = await this.playFrom(current, target);
      return { success: result.handled && !result.failed };
    }
    this.cancelCompletion();
    const progress = await this.api.saveProgress(current.episode_id, {
      position_ms: target,
      duration_ms: this.durationFrom({}, current),
      status: "paused",
      device_id: process.env.MIGPT_DEVICE_ID || "",
    }).catch(() => undefined);
    if (!progress) return { success: false };
    if (state.current?.episode_id === current.episode_id) state.current.progress = progress;
    this.restartOnResume = true;
    return { success: true };
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
    if (!state.current || state.current.progress?.status === "completed") return this.fail("当前没有可继续播放的播客。");
    const status = await this.speaker.getPlaying(true);
    if (status === "idle") {
      return this.play({
        type: "play",
        query: state.current.podcast_title,
        season: state.current.season,
        episode: state.current.episode,
      });
    }
    if (this.restartOnResume || this.playingSpeed !== this.desiredSpeed) {
      // 暂停期间改了倍速或进度（或 MiGPT 重启后音箱里仍是原速音频），
      // 旧音频不能直接继续，从保存的断点按当前倍速重新拉流。
      const result = await this.playFrom(state.current, Number(state.current.progress?.position_ms || 0));
      return result.failed ? result : this.reply("继续播放。", false);
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
    this.clearStream();
    return this.reply("已停止播放。", false);
  }

  private async restart() {
    await this.ensureCurrent();
    if (!state.current) return this.fail("当前没有正在播放的播客。");
    return this.play({ type: "play", query: state.current.podcast_title, season: state.current.season, episode: state.current.episode, fromStart: true });
  }

  private async adjacent(direction: 1 | -1) {
    await this.ensureCurrent();
    if (!state.current) return this.fail("当前没有正在播放的播客。");
    const current = state.current;
    // 优先使用搜索接口按季集获取目标节目，避免 getEpisode(id) 在远程服务上
    // 约 5 秒的详情查询延迟；若节目编号不连续，再回退到 next/previous id。
    const targetEpisode = current.episode + direction;
    const searched = await this.api.resolveEpisode(current.podcast_title, current.season, targetEpisode).catch(() => []);
    let episode = !Array.isArray(searched) ? searched : undefined;
    if (!episode) {
      const nextId = direction > 0 ? current.next_episode_id : current.previous_episode_id;
      if (!nextId) return this.fail(direction > 0 ? "已经是最后一集了。" : "已经是第一集了。");
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
    if (minutes <= 0) return this.fail("定时时间必须大于零。");
    if (timer) clearTimeout(timer);
    state.timerUntil = Date.now() + minutes * 60_000;
    timer = setTimeout(async () => {
      await this.saveCurrentProgress("timer_stopped");
      this.cancelCompletion();
      this.clearStream();
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
    // 同步记下调用时的节目和倍速流：切集时本方法不等待就继续播放新节目，
    // 读到播放器上下文时 state.current 可能已经是下一集。
    const current = state.current;
    const stream = this.activeStream;
    const restartOnResume = this.restartOnResume;
    if (!current) return;
    const playbackContext = context || await this.speaker.getPlaybackContext().catch(() => ({}));
    // 播放器里是别的音频时不上报，保留 PodSuite 中已有的断点。
    if (this.isForeignAudio(playbackContext, current, stream)) return undefined;
    // 暂停期间拖动过进度时，播放器里仍是旧位置，以已保存的目标断点为准。
    const position = (restartOnResume ? undefined : this.positionFrom(playbackContext, current, stream))
      ?? Number(current.progress?.position_ms || 0);
    const duration = this.durationFrom(playbackContext, current, stream);
    const progress = await this.api.saveProgress(current.episode_id, {
      position_ms: position,
      duration_ms: duration,
      status,
      device_id: process.env.MIGPT_DEVICE_ID || "",
    }).catch(() => undefined);
    if (progress && state.current?.episode_id === current.episode_id) state.current.progress = progress;
    return progress;
  }

  /** 播放器已停止：断点已保存到 PodSuite，之后的状态和续播都以保存的断点为准。 */
  private clearStream() {
    this.activeStream = undefined;
    this.restartOnResume = false;
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
    // 倍速播放时剩余的真实时间按倍速缩短。
    const delay = Math.max(250, (durationMs - positionMs) / (this.activeStream?.speed ?? 1) - 2_000);
    this.completionTimer = setTimeout(() => void this.checkCompletion(generation, positionMs), delay);
    this.completionTimer.unref();
  }

  private async checkCompletion(generation: number, previousPosition: number) {
    if (generation !== this.completionGeneration || !state.current) return;
    const status = await this.speaker.getPlaying(true);
    const context = await this.speaker.getPlaybackContext().catch(() => ({} as Record<string, unknown>));
    if (this.isForeignAudio(context)) {
      // 刚开始播放或跳转后，播放器还在装载新音频（倍速流尤其明显），上报的仍是旧音频：
      // 继续等待，否则拖到结尾附近时完播检测会就此中断，播完也不会进入下一集。
      // 超过装载时间仍是别的音频，说明播客已被替换（如用户让原生小爱放音乐），不再判定完播。
      if (Date.now() - this.playStartedAt < PLAYBACK_LOAD_WINDOW_MS && generation === this.completionGeneration) {
        this.completionTimer = setTimeout(() => void this.checkCompletion(generation, previousPosition), 200);
        this.completionTimer.unref();
      }
      return;
    }
    const position = this.positionFrom(context);
    const duration = this.durationFrom(context, state.current);
    const naturallyFinished = Boolean(duration && previousPosition > duration * 0.8 && (
      status === "idle" || position === undefined || position >= duration - 150 || position + 1_000 < previousPosition
    ));
    if (naturallyFinished) {
      await this.finishEpisode(state.current, status);
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

  /** 标记本集完成，并自动进入下一集；设置了定时停止或没有下一集时停止播放。 */
  private async finishEpisode(episode: Episode, status: "playing" | "paused" | "idle") {
    this.cancelCompletion();
    const progress = await this.api.complete(episode.episode_id, process.env.MIGPT_DEVICE_ID || "").catch(() => undefined);
    if (progress && state.current?.episode_id === episode.episode_id) state.current.progress = progress;
    // 设置了定时停止时，当前节目播完即停，不跨集继续播放；定时器仍由
    // setTimer 管理。未设置定时器则无缝衔接下一集，直到 PodSuite 找不到
    // 后续节目为止。pause/stop 会提前 cancelCompletion，因此不会误触发。
    if (!state.timerUntil) {
      const advanced = await this.advanceAfterCompletion(state.current || episode);
      if (advanced) return;
    }
    if (status !== "idle") await this.speaker.stop();
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

  /** 指令未执行时的回复：照常播报给音箱，同时标记 failed 供管理页区分提示样式。 */
  private fail(text: string, speak = true): PodcastHandleResult {
    return { ...this.reply(text, speak), failed: true };
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
