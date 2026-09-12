import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID } from "node:crypto";
import { PodcastApiClient } from "./podcast/api-client.js";
import { PodcastController } from "./podcast/controller.js";
import { ConversationStore, JsonStore } from "./persistence.js";
import { ControlServer, type MigptRuntimeConfig } from "./control/http-server.js";
import { join } from "node:path";
import { ChatBot } from "@mi-gpt/chat";
import { OpenAI } from "@mi-gpt/openai";
import { MicArbiter } from "./mic-arbiter.js";
import { parsePodcastCommand } from "./podcast/command-parser.js";

export type OpenXiaoAIConfig = Prettify<EngineConfig<OpenXiaoAIEngine> & {
  podsuite?: { url?: string; token?: string };
  control?: Partial<MigptRuntimeConfig>;
}>;

export interface MigptConnectionStatus {
  connected: boolean;
  address?: string;
  connectedAt?: string;
  device?: { model: string; sn: string };
}

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

/**
 * 首次升级到 Web 配置模式时清理旧版配置文件中的业务配置。
 *
 * 旧版配置文件可能包含通过环境变量或旧默认值写入的地址、模型和密钥。
 * 由于无法区分它们是否为用户主动填写，第一次升级统一清空业务配置，
 * 用户可在管理页面重新保存；设备列表和系统提示词仍然保留。
 */
function normalizePersistedConfig(config: MigptRuntimeConfig) {
  if (config.configVersion === 1) return { config, changed: false };
  return {
    config: {
      ...config,
      configVersion: 1,
      // 保留原有管理 Token，避免升级后管理页面意外变成未鉴权状态。
      apiToken: config.apiToken || "",
      podsuiteUrl: "",
      podsuiteToken: "",
      openai: { baseURL: "", apiKey: "", model: "" },
    },
    changed: true,
  };
}

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;
  podcastController?: PodcastController;
  controlServer?: ControlServer;
  conversations?: ConversationStore;
  private readonly micArbiter = new MicArbiter(process.env.MIGPT_EXCLUSIVE_MIC !== "0");
  private nativeNlpDisabled = false;
  private connection: MigptConnectionStatus = { connected: false };
  private wakeResumeTimer?: ReturnType<typeof setTimeout>;
  /** 当前这一轮唤醒是否已经暂停了 MiGPT 播放。状态在异步暂停完成前就锁定，
   * 防止 VAD_BEGIN 后马上到达 FINAL 时发生竞态。 */
  private wakeCaptureActive = false;
  private wakeCaptureHasText = false;
  /** 最近一次确认播放器处于播放状态的时间。客户端在 VAD 前会先
   * 本地暂停以抢麦，Paused 事件可能比 instruction 事件先到；用这个时间
   * 窗口仍能判断“暂停前确实在播放”，避免只唤醒不说话时无法恢复播客。 */
  private lastPlayingAt = 0;
  /** VAD 触发的暂停是异步 RPC；最终 ASR 到达前必须等待它完成，
   * 否则新的回答可能在旧音频尚未停下时启动。 */
  private voiceCapturePause?: Promise<void>;
  private messageQueue: Promise<void> = Promise.resolve();
  private suppressAiErrorUntil = 0;
  /** 当前正在被 MiGPT 消费的流式回答。取消 OpenAI 请求本身并不会清空
   * StreamResponse 已经缓冲的句子，因此唤醒/停止时必须同时 cancel stream。 */
  private activeAiStream?: Awaited<ReturnType<typeof ChatBot.chatWithStream>>;
  private aiResponseGeneration = 0;
  /** 最近一次 AI 回答后的连续对话窗口。窗口内未命中播客/原生控制词的
   * 后续 ASR 会继续交给 AI，而不是落到已被独占麦克风屏蔽的原生 NLP。 */
  private aiConversationUntil = 0;
  /** 原生 TTS 期间，固件偶尔会把回声写入 origin_text 而 text 为空；
   * 记录一个短暂窗口，过滤这类无法可靠区分来源的回声。 */
  private nativeTtsUntil = 0;
  /** 每个 VAD 轮次只消费一个最终结果。固件可能在同一轮写入多个
   * 不同 dialog_id 的重复 FINAL，若全部调用 ai_service 会复用旧 dialog
   * 并使原生回复失败。 */
  private voiceTurn = 0;
  private handledVoiceTurn = -1;

  constructor() {
    super();
    OpenXiaoAISpeaker.suppressMicEcho = (milliseconds, text) => this.micArbiter.suppressFor(milliseconds, text);
  }

  async start(config: OpenXiaoAIConfig) {
    await super.start(deepMerge(kDefaultOpenXiaoAIConfig, config));
    const runtime = this.config as OpenXiaoAIConfig & {
      podsuite?: { url?: string; token?: string };
      control?: Partial<MigptRuntimeConfig>;
    };
    // Docker 通过 MIGPT_WORKDIR=/data 挂载持久卷；本地运行默认使用项目内 data，避免写入根目录。
    const workdir = process.env.MIGPT_WORKDIR || join(process.cwd(), "data");
    this.conversations = new ConversationStore(join(workdir, "conversations.json"));
    await this.conversations.load();
    this.podcastController = new PodcastController(
      new PodcastApiClient({
        baseUrl: runtime.podsuite?.url || "",
        token: runtime.podsuite?.token || undefined,
      }),
      OpenXiaoAISpeaker,
      this.conversations,
    );
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    // Rust websocket 服务持续运行，不能阻塞独立管理 API 的启动。
    void RustServer.start();
    const controlConfig: MigptRuntimeConfig = {
      configVersion: 1,
      host: runtime.control?.host || process.env.MIGPT_HOST || "0.0.0.0",
      port: Number(runtime.control?.port || process.env.MIGPT_PORT || 4398),
      // 业务配置不再从环境变量读取，首次启动时为空，由管理页面写入 /data/config.json。
      apiToken: runtime.control?.apiToken || "",
      podsuiteUrl: runtime.podsuite?.url || "",
      podsuiteToken: runtime.podsuite?.token || "",
      openai: {
        baseURL: this.config.openai?.baseURL || "",
        apiKey: this.config.openai?.apiKey || "",
        model: this.config.openai?.model || "",
      },
      prompt: { system: this.config.prompt?.system || "" },
      devices: runtime.control?.devices || [],
    };
    const configStore = new JsonStore<MigptRuntimeConfig>(join(workdir, "config.json"), controlConfig);
    const loadedConfig = await configStore.load();
    const { config: persisted, changed: normalizedPersistedConfig } = normalizePersistedConfig(loadedConfig);
    if (normalizedPersistedConfig) await configStore.save(persisted);
    Object.assign(controlConfig, persisted, { openai: { ...controlConfig.openai, ...persisted.openai }, prompt: { ...controlConfig.prompt, ...persisted.prompt } });
    this.podcastController.updateApi({ baseUrl: controlConfig.podsuiteUrl, token: controlConfig.podsuiteToken });
    Object.assign(this.config, { openai: controlConfig.openai, prompt: controlConfig.prompt });
    ChatBot.init(this.config);
    this.controlServer = new ControlServer(
      controlConfig,
      configStore,
      this.podcastController,
      OpenXiaoAISpeaker,
      this.conversations,
      join(process.cwd(), "web"),
      (next) => {
        this.podcastController?.updateApi({ baseUrl: next.podsuiteUrl, token: next.podsuiteToken });
        Object.assign(this.config, { openai: next.openai, prompt: next.prompt });
        ChatBot.init(this.config);
      },
      () => ({ ...this.connection, device: this.connection.device && { ...this.connection.device } }),
    );
    this.controlServer.listen();
  }

  /**
   * 新的用户输入到达时让引擎取消上一条 OpenAI 流式回答。
   * 对天气、知识问答等非播客请求，先停止正在播放的 MiGPT TTS，避免
   * AI、播客和原生小爱同时出声；播客控制命令交给 PodcastController，
   * 由它先保存进度再暂停/停止，不能在这里提前打断。
   */
  override async onMessage(msg: Parameters<MiGPTEngine["onMessage"]>[0]) {
    const podcastIntent = parsePodcastCommand(msg.text);
    const looksLikePodcast = Boolean(
      podcastIntent || /播客|博客|波客|播克|下一集|上一集|第\s*\d+\s*[集季]/.test(msg.text) ||
      /^(?:播放|播|听|收听)\s*/.test(msg.text)
    );
    const urgentStop = podcastIntent?.type === "stop";
    // FINAL ASR 到达时也要使旧的 _response 立即失效。仅调用 OpenAI.cancel()
    // 无法阻止 MiGPT 继续消费已经缓冲在 StreamResponse 中的文本片段。
    this.cancelActiveAiResponse();
    if (urgentStop) {
      // “停止”是最高优先级命令，不能等待 PodSuite 保存进度或其它网络请求。
      // 先静音，再让播客控制器异步保存断点并播报确认。
      this.suppressAiErrorUntil = Date.now() + 5000;
      this.podcastController?.cancelSpeech();
      // 播客媒体由 PodcastController 并发捕获播放上下文后停止；如果这里
      // 先重启播放器会丢掉本次停止前的断点。TTS/未知播放则立即强制停止。
      if (this.speaker.activePlayback !== "media") {
        await this.speaker.stop().catch(() => false);
      }
      if (this.speaker.nativeReplyInProgress) {
        await this.speaker.abortXiaoAI(true).catch(() => false);
      }
    }
    // AI/TTS 必须在任何新用户指令前立即停止；播客媒体则交给控制器先保存
    // 断点再切换，避免“回答量子计算”和新播客重叠播放。
    if (!urgentStop && (OpenXiaoAISpeaker.isTtsActive || (!looksLikePodcast && this.speaker.status === "playing"))) {
      this.podcastController?.cancelSpeech();
      this.suppressAiErrorUntil = Date.now() + 5000;
      await this.speaker.stop().catch(() => false);
    }
    // MiGPT 引擎默认只会将 callAIKeywords 开头的消息交给 AI。连续对话
    // 时后续句子通常没有“请问/你知道”前缀；临时放宽为全部文本，再由
    // config.ts 的原生控制词白名单拦截天气、时间、音量等设备指令。
    const previousKeywords = this.config.callAIKeywords;
    if (this.shouldContinueAI()) this.config.callAIKeywords = [""];
    try {
      return await super.onMessage(msg);
    } finally {
      this.config.callAIKeywords = previousKeywords;
    }
  }

  shouldContinueAI() {
    return Date.now() < this.aiConversationUntil;
  }

  /** 管理页面尚未填写完整模型配置时，不向第三方接口发起请求。 */
  isAIConfigured() {
    const openai = this.config.openai;
    return Boolean(openai?.baseURL?.trim() && openai?.apiKey?.trim() && openai?.model?.trim());
  }

  /**
   * MiGPT 默认把 OpenAI 请求被用户打断也当成错误并播报“出错了”。
   * 唤醒新指令时这是预期的取消，必须静默丢弃，否则错误 TTS 会抢在新
   * 播客提示音前播放。
   */
  override async askAI(msg: Parameters<MiGPTEngine["askAI"]>[0]): Promise<{
    stream: Awaited<ReturnType<typeof ChatBot.chatWithStream>>;
  }> {
    this.aiConversationUntil = Date.now() + Number(process.env.MIGPT_CONTINUOUS_DIALOG_MS || 120_000);
    const generation = this.aiResponseGeneration;
    const stream = await ChatBot.chatWithStream(msg, async (error) => {
      if (generation !== this.aiResponseGeneration || Date.now() < this.suppressAiErrorUntil) {
        console.log("⏹️ 已取消上一条 AI 回答", error?.name || "request aborted");
        return;
      }
      await this.speaker.play({ text: "出错了，请稍后再试吧！", blocking: true });
    });
    // VAD 可能在 ChatBot 创建 StreamResponse 的微小窗口内到达；这种情况
    // 仍要取消刚创建的流，不能让它在下一轮继续吐出旧回答。
    if (generation !== this.aiResponseGeneration) {
      stream.cancel();
    } else {
      this.activeAiStream = stream;
      void stream.result().finally(() => {
        if (this.activeAiStream === stream) this.activeAiStream = undefined;
      });
    }
    return { stream };
  }

  private cancelActiveAiResponse() {
    this.aiResponseGeneration += 1;
    this.activeAiStream?.cancel();
    this.activeAiStream = undefined;
    OpenAI.cancel(this.lastMsg?.id);
    // MiGPTEngine._response() 通过 lastMsg.timestamp 判断是否有新消息。
    // VAD 不是 FINAL ASR，不会自动更新 lastMsg，所以这里主动推进时间戳，
    // 让正在等待 speaker.play() 返回的旧响应在下一片文本前退出。
    if (this.lastMsg) {
      this.lastMsg = {
        ...this.lastMsg,
        timestamp: Math.max(Date.now(), this.lastMsg.timestamp + 1),
      };
    }
  }

  private async pauseForVoiceCapture() {
    if (this.wakeCaptureActive) return;
    // 先设置状态再 await 远程命令。OH2P 的 playing 事件有延迟，若等状态
    // 更新后再设置，FINAL ASR 可能抢先清掉状态，导致背景播客继续播放。
    this.wakeCaptureActive = true;
    this.wakeCaptureHasText = false;
    const mediaWasActive = OpenXiaoAISpeaker.activePlayback === "media";
    const mediaWasPlaying = mediaWasActive && (
      OpenXiaoAISpeaker.status === "playing"
      || (OpenXiaoAISpeaker.status === "paused" && Date.now() - this.lastPlayingAt < 1_000)
    );
    const ttsWasActive = OpenXiaoAISpeaker.isTtsActive;
    // OH2P 的原生 TTS 不一定上报独立的 activePlayback；在 VAD 到达时
    // 若当前是 idle 媒体标记但播放器仍为 playing，说明正在播原生回复。
    // 将该事实锁存到最终 ASR，避免 waitForNativeReply 因暂停状态误判结束，
    // 导致下一条“几点了”没有先中断上一条天气回复。
    const nativeWasActive = OpenXiaoAISpeaker.nativeReplyInProgress ||
      (!mediaWasActive && OpenXiaoAISpeaker.status === "playing");
    if (nativeWasActive) {
      OpenXiaoAISpeaker.nativeReplyInProgress = true;
      // 让 askXiaoAI 中后台 waitForNativeReply 立即失效。VAD 会先把
      // 播放器置为 paused；若不使 generation 失效，后台等待会把这次
      // “暂停以收音”误判成原生回复自然结束，并在新 ASR 到达前恢复独占
      // 状态，导致下一条 ai_service 返回 code=-1。
      OpenXiaoAISpeaker.nativeRequestGeneration += 1;
    }
    this.podcastController?.cancelSpeech();
    // VAD_BEGIN 比 FINAL ASR 早到几百毫秒；先取消正在生成的 AI 流，
    // 否则流式 TTS 会继续吐出下一段文字，和用户的新指令重叠播放。
    this.suppressAiErrorUntil = Date.now() + 5000;
    this.cancelActiveAiResponse();
    console.log("🎙️ VAD 开始", {
      activePlayback: OpenXiaoAISpeaker.activePlayback,
      status: OpenXiaoAISpeaker.status,
      mediaWasActive,
    });
    // 先发一个不依赖播放类型的暂停命令。OH2P 对 tts_play.sh 报告 idle，
    // 但它仍可能有 miplayer 子进程在输出；无条件暂停可把原生回复、播客
    // 以及未知播放器都立即静音，随后再按类型保存断点或清理进程。
    await OpenXiaoAISpeaker.interruptOutput?.().catch(() => false);
    // TTS/原生回复优先于播客处理。极端竞态下 activePlayback 可能仍是
    // media，但旧的回答进程或原生请求尚未清理；先结束它们，不能让它们
    // 在暂停播客后继续输出。
    if (ttsWasActive) {
      const ok = await OpenXiaoAISpeaker.stop();
      if (ok) {
        console.log("⏹️ 开始语音识别，已停止 MiGPT 语音");
      }
    }
    if (nativeWasActive) {
      // 原生小爱正在回答时，VAD_BEGIN 只负责把声音暂停，不能在这里重启
      // mico_aivs_lab。重启服务会同时结束当前的 DuplexRecognize 会话，
      // 导致这一轮唤醒的最终 ASR（例如“几点了”）被丢掉。等最终 ASR
      // 已经写入 instruction.log 后，再由 onEvent 里的延迟中断重启服务。
      console.log("⏸️ 开始语音识别，已暂停原生小爱语音，等待最终 ASR");
    }
    if (!ttsWasActive && !nativeWasActive && mediaWasActive) {
      // 不能用 Promise 的 ||：pauseForWake() 返回 Promise，即使最终结果为
      // false 也会让右侧 fallback 永远不执行。远程 API 偶发失败时这正是
      // “唤醒只压低音量、播客仍在播放”的原因。
      let ok = false;
      try {
        ok = this.podcastController ? await this.podcastController.pauseForWake() : false;
      } catch (error) {
        console.warn("⚠️ 保存播客进度时出错", error);
      }
      if (!ok) ok = await OpenXiaoAISpeaker.setPlaying(false).catch(() => false);
      if (ok) {
        console.log("⏸️ 开始语音识别，已暂停当前播放");
      } else {
        console.warn("⚠️ VAD 暂停播放失败", { status: OpenXiaoAISpeaker.status });
      }
    } else if (!ttsWasActive && !nativeWasActive && OpenXiaoAISpeaker.status === "playing") {
      // 处理未被 MiGPT 标记为 media 的原生音乐/提示音。独占麦克风只
      // 禁止新的 NLP，并不会自动暂停音频，所以 VAD 时必须显式静音。
      const ok = await OpenXiaoAISpeaker.setPlaying(false).catch(() => false);
      if (ok) console.log("⏸️ 开始语音识别，已暂停音箱当前播放");
    }
    if (this.wakeResumeTimer) clearTimeout(this.wakeResumeTimer);
    this.wakeResumeTimer = setTimeout(() => {
      if (this.wakeCaptureActive && !this.wakeCaptureHasText) {
        if (mediaWasPlaying && OpenXiaoAISpeaker.status === "paused") {
          void OpenXiaoAISpeaker.setPlaying(true);
          console.log("▶️ 未识别到新指令，已恢复播放");
        } else if (nativeWasActive && OpenXiaoAISpeaker.nativeReplyInProgress) {
          // 只唤醒但没有说新指令时，不要永久停住原生回答；如果原生请求
          // 仍然有效，恢复它的播放器即可，下一次唤醒仍可再次抢麦。
          void OpenXiaoAISpeaker.setPlaying(true);
          console.log("▶️ 未识别到新指令，已恢复原生小爱语音");
        }
      }
      this.wakeCaptureActive = false;
      this.wakeCaptureHasText = false;
      this.wakeResumeTimer = undefined;
    }, 6000);
    this.wakeResumeTimer.unref();
  }

  /** 启动一次暂停并保存 Promise，供紧随其后的 FINAL ASR 等待。 */
  private startVoiceCapturePause() {
    if (this.voiceCapturePause) return this.voiceCapturePause;
    const pause = this.pauseForVoiceCapture();
    this.voiceCapturePause = pause;
    void pause.finally(() => {
      if (this.voiceCapturePause === pause) this.voiceCapturePause = undefined;
    });
    return pause;
  }

  private finishVoiceCapture(hasText: boolean) {
    if (this.wakeResumeTimer) clearTimeout(this.wakeResumeTimer);
    this.wakeResumeTimer = undefined;
    if (hasText) this.wakeCaptureHasText = true;
    // 有最终 ASR 文本代表用户确实说了指令，保持暂停并交给 MiGPT/原生小爱；
    // 没有文本（只唤醒、未继续说话）则立即恢复播放。
    if (!hasText && this.wakeCaptureActive && OpenXiaoAISpeaker.status === "paused") {
      void OpenXiaoAISpeaker.setPlaying(true);
      console.log("▶️ 唤醒后没有新指令，已恢复播放");
    }
    // 本轮指令已经交给上层处理；下一次唤醒仍需重新执行暂停逻辑。
    this.wakeCaptureActive = false;
    this.wakeCaptureHasText = false;
  }

  private dispatchMessage(msg: Parameters<MiGPTEngine["onMessage"]>[0]) {
    // 不能把 FINAL ASR 串行排在上一条 blocking TTS 后面：播客首次点播会
    // 播放“你想听第几集？”并等待进程结束，用户回答“第5集”时若继续排队，
    // 就要等完整提示音结束才处理，甚至被旧 stream 阻塞。每条最终 ASR
    // 进入独立任务；onMessage 开头会取消旧 AI/TTS，PodcastController 自身
    // 负责保存断点和切换播放，避免新指令被提示音吞掉。
    void this.onMessage(msg).catch((error) => console.error("❌ 处理语音指令失败", error));
  }

  private isIncompleteVoiceCommand(text: string) {
    return /^(?:播放|播|听|收听)(?:播客|博客|波客|播克)?$/.test(text.trim());
  }

  /**
   * 收到事件
   */
  onEvent = async (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "connected") {
      const address = typeof e.data?.address === "string" ? e.data.address : undefined;
      this.connection = {
        connected: true,
        address,
        connectedAt: new Date().toISOString(),
      };
      if (this.micArbiter.shouldAbortNative()) {
        this.nativeNlpDisabled = await this.speaker.setExclusiveMic(true);
        this.connection.device = await this.speaker.getDevice().catch(() => undefined);
        console.log(this.nativeNlpDisabled
          ? "✅ 已启用独占麦克风：小米仅负责语音识别"
          : "⚠️ 独占麦克风初始化失败，将按指令中断原生小爱");
        if (process.env.MIGPT_CONNECTED_PROMPT !== "0") {
          const prompt = process.env.MIGPT_CONNECTED_PROMPT || "已连接";
          console.log(`🔔 播放连接提示音：${prompt}`);
          const played = await this.speaker.play({
            text: prompt,
            blocking: true,
          }).catch((error) => {
            console.warn("⚠️ 已连接提示音播放失败", error);
            return false;
          });
          console.log(played ? "✅ 已连接提示音播放完成" : "⚠️ 已连接提示音未播放");
        }
      }
    } else if (e.event === "disconnected") {
      const address = typeof e.data?.address === "string" ? e.data.address : undefined;
      if (!address || !this.connection.address || address === this.connection.address) {
        this.connection = { connected: false };
        this.nativeNlpDisabled = false;
      }
    } else if (e.event === "playing") {
      // 更新播放状态
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
      if (e.data === "Playing") this.lastPlayingAt = Date.now();
      // 播客自然结束或被音箱外部停止后清除媒体标记；TTS 不依赖该事件，
      // 因此不能无条件把 activePlayback 改成 idle。
      if (OpenXiaoAISpeaker.activePlayback === "media" && e.data !== "Playing" && e.data !== "Paused") {
        OpenXiaoAISpeaker.activePlayback = "idle";
      }
    } else if (e.event === "instruction" && e.data.NewLine) {
      // 收到语音识别结果
      const line = jsonDecode(e.data.NewLine);
      const namespace = line?.header?.namespace;
      const name = line?.header?.name;
      const dialogId = line?.header?.dialog_id;
      // ai_service 的返回值只表示请求已提交。把原生执行阶段的事件也记
      // 录下来，便于区分“已提交但没有声音”和真正开始播报。
      if (namespace === "SpeechSynthesizer" && ["Speak", "SpeakStream"].includes(name)) {
        console.log("🔊 原生 TTS 已开始", { dialogId, name, text: line?.payload?.text || "" });
        this.nativeTtsUntil = Date.now() + 15_000;
        // OH2P 的 mphelper mute_stat 对原生 TTS 常返回 idle，后台等待器
        // 可能因此提前认为回复结束。以 ai_service 返回的 dialog_id 关联
        // Speak 事件，锁存“原生正在播报”，确保下一次唤醒会真正中断它。
        OpenXiaoAISpeaker.markNativeTtsStarted(dialogId);
        const spokenText = typeof line?.payload?.text === "string" ? line.payload.text : "";
        if (spokenText) this.micArbiter.suppressFor(15_000, spokenText);
      }
      if (
        namespace === "SpeechSynthesizer" &&
        name === "FinishSpeakStream" &&
        dialogId &&
        dialogId === OpenXiaoAISpeaker.nativeReplyDialogId
      ) {
        // 不能依赖 mphelper mute_stat 判断原生回复是否结束：OH2P 对云端
        // 流式 TTS 经常一直返回 idle。以固件明确的 FinishSpeakStream
        // 事件作为结束信号，避免长天气回复中途被误判完成。
        OpenXiaoAISpeaker.markNativeTtsFinished(dialogId);
      }
      if (namespace === "System" && name === "Exception") {
        console.warn("⚠️ 原生小爱执行失败", { dialogId, payload: line?.payload });
        if (dialogId && [OpenXiaoAISpeaker.nativeReplyDialogId, OpenXiaoAISpeaker.nativeReplySourceDialogId].includes(dialogId) && OpenXiaoAISpeaker.nativeReplyInProgress) {
          OpenXiaoAISpeaker.nativeReplyInProgress = false;
          // 仅对当前请求补一次可听见的反馈，避免 ai_service code=0 被误报
          // 为成功而让用户长时间无声。新指令到来时 generation 会失效。
          void OpenXiaoAISpeaker.play({ text: "原生小爱服务暂时没有响应，请稍后再试", blocking: true }).catch(() => false);
        }
      }
      if (
        namespace === "SpeechRecognizer" &&
        name === "RecognizeResult" &&
        line?.payload?.is_vad_begin
      ) {
        this.voiceTurn += 1;
        // VAD_BEGIN 说明这次确实是用户重新唤醒；即使上一个原生 TTS
        // 尚未完全结束，也不能把随后只有 origin_text 的短指令当回声。
        this.nativeTtsUntil = 0;
        // 不依赖 KWS 日志：VAD 开始意味着用户已开始说话，必须先暂停
        // 播客，否则背景音会覆盖后续指令。
        void this.startVoiceCapturePause();
      }
      const recognizeResult = line?.payload?.results?.[0];
      // OH2P 1.62.2 在网络抖动或连续对话时会把最终文本写入
      // `origin_text`，而 `text` 留空。若只读取 text，Node 看不到用户的
      // “几点了/第5集”，固件随后会自行走 NLP 并经常返回 code=111。
      const recognizedText = recognizeResult?.text || recognizeResult?.origin_text;
      if (!recognizeResult?.text && recognizeResult?.origin_text && Date.now() < this.nativeTtsUntil) {
        console.log("🔇 忽略原生 TTS 回声", { text: recognizeResult.origin_text, dialogId });
        return;
      }
      if (
        namespace === "SpeechRecognizer" &&
        name === "RecognizeResult" &&
        line?.payload?.is_final &&
        typeof recognizedText === "string" &&
        recognizedText.trim()
      ) {
        if (this.voiceTurn > 0 && this.handledVoiceTurn === this.voiceTurn) {
          console.log("🔇 忽略同一轮重复 ASR", { dialogId, text: recognizedText });
          return;
        }
        this.handledVoiceTurn = this.voiceTurn;
        const text = recognizedText.trim();
        console.log("🎙️ ASR 最终结果", {
          dialogId: line.header.dialog_id,
          text,
          activePlayback: OpenXiaoAISpeaker.activePlayback,
          status: OpenXiaoAISpeaker.status,
        });
        // VAD_BEGIN 与 FINAL ASR 在 Rust 层并发分发。暂停/清理播放器是
        // 异步 RPC，如果这里不等待它完成，下面的 ai_service 可能和
        // interruptOutput 同时抵达音箱，导致请求虽返回 code=0 却没有声音，
        // 或者只播放开头几个字。等待同一轮 VAD 的暂停任务完成，不阻塞
        // WebSocket 读循环，也不会影响下一轮事件的接收。
        if (this.voiceCapturePause) {
          await this.voiceCapturePause.catch((error) => {
            console.warn("⚠️ 等待 VAD 暂停完成失败，继续处理指令", error);
          });
        }
        // 最终 ASR 已经落盘，现在才可以重启原生服务。必须放在 VAD_BEGIN
        // 之后而不是之前，否则 mico_aivs_lab 重启会吞掉本轮 ASR。
        let nativeInterrupted = false;
        if (this.speaker.nativeReplyInProgress) {
          await this.speaker.abortXiaoAI(true).catch(() => false);
          nativeInterrupted = true;
          console.log("⏹️ 已收到新指令，停止上一条原生小爱回复");
        }
        // “播放”是 OH2P 偶发的提前 FINAL，不算完整新指令；立即恢复此前
        // 暂停的播客，且不会再转交原生小爱（config.ts 有同样的防护）。
        this.finishVoiceCapture(Boolean(text) && !this.isIncompleteVoiceCommand(text));
        // “停止/暂停”等控制词必须始终执行。音箱可能把同一条 ASR 重复
        // 上报，去重只适用于普通文本；否则用户第二次说“停止”会被当成
        // 回声丢弃，表现为播放器无法停止。
        const controlIntent = parsePodcastCommand(text);
        const isControl = controlIntent && [
          "stop", "pause", "resume", "next", "previous", "restart", "timer", "cancelTimer",
        ].includes(controlIntent.type);
        if (!isControl && this.micArbiter.isDuplicate(text, dialogId)) return;
        this.conversations?.append({ type: "asr", text, source: "xiaomi", at: new Date().toISOString() });
        OpenXiaoAISpeaker.nativeReplySourceDialogId = dialogId;
        // OH2P 1.62.2 在独占麦克风实验模式下偶发留下一个隐藏 NLP 会话：
        // ai_service 返回 code=0，但 instruction.log 没有 Speak，表现为
        // “天气/时间”完全无声。最终 ASR 已经落盘，此时重启服务可清空该
        // 会话；speaker.askXiaoAI 随后会等待服务恢复再提交请求。原生回复
        // 已在上一分支中被中断时不重复重启。
        if (this.micArbiter.shouldAbortNative() && !nativeInterrupted) {
          await this.speaker.abortXiaoAI(true, { restartService: true }).catch((error) => {
            console.warn("⚠️ 清理原生隐藏会话失败，继续处理指令", error);
          });
        }
        // /data/pns.lab 已经让本轮 ASR 只上报文本；没有正在播放的原生
        // 回复时不要再发送 event_notify。该通知会切换固件的收音/播放状态，
        // 紧接着调用 ai_service 时可能只生成 instruction.log 而不打开音频
        // 输出。只有 nativeInterrupted 分支（确有上一条原生回复）才需要
        // 通过 abortXiaoAI 清理旧队列。
        this.dispatchMessage({
          text,
          id: randomUUID(),
          sender: "user",
          timestamp: Date.now(),
        });
      }
    } else if (e.event === "kws") {
      const keyword = e.data;
      console.log("🔥 唤醒词识别", keyword);
      // KWS 日志存在时提前暂停；没有 KWS 日志时，instruction 的 VAD_BEGIN
      // 也会走同一套逻辑。
      void this.startVoiceCapturePause();
    }
  };

  /**
   * 收到录音音频流
   */
  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
