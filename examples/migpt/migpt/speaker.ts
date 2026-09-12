import { jsonEncode } from "@mi-gpt/utils/parse";
import { RustServer } from "./open-xiaoai.js";
import type { ISpeaker } from "@mi-gpt/engine/base";
import { createHash } from "node:crypto";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

function shellQuote(value: string | undefined) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

class SpeakerManager implements ISpeaker {
  status: "playing" | "paused" | "idle" = "idle";
  lastAbortAt = 0;
  exclusiveMic = false;
  /** 是否由 MiGPT 管理独占麦克风。临时关闭 /data/pns.lab 以调用原生
   * ai_service 时仍保持 true，下一条原生请求结束后才能正确恢复独占。 */
  exclusiveMicManaged = false;
  nativeReplyInProgress = false;
  /** ai_service 返回成功仅代表请求入队，真正的 TTS 可能稍后才开始。 */
  nativeReplyDialogId?: string;
  /** 当前 ai_service 对应的 Speak/SpeakStream 是否已经真正到达。 */
  nativeReplyTtsStarted = false;
  /** 发起原生请求的 ASR dialog，用于关联固件返回的 System.Exception。 */
  nativeReplySourceDialogId?: string;
  /** 每次原生请求递增；强制中断后，旧请求不得再恢复独占模式或继续上报成功。 */
  nativeRequestGeneration = 0;
  playbackGeneration = 0;
  activePlayback: "tts" | "media" | "idle" = "idle";
  /** 独立于音箱 playing 事件的 TTS 状态。OH2P 不会为 miplayer TTS
   * 稳定上报 playing，因此不能只看 status/activePlayback。 */
  ttsProcessActive = false;
  suppressMicEcho?: (milliseconds?: number, text?: string) => void;

  get isTtsActive() {
    return this.ttsProcessActive || this.activePlayback === "tts";
  }

  /**
   * 获取播放状态
   */
  async getPlaying(sync = false) {
    if (sync) {
      // 同步远端最新状态
      const res = await this.runShell("mphelper mute_stat");
      const remoteStatus = res?.stdout.trim();
      if (remoteStatus === "1") {
        this.status = "playing";
      } else if (remoteStatus === "2") {
        this.status = "paused";
      } else if (["0", "3"].includes(remoteStatus || "")) {
        this.status = "idle";
      }
    }
    return this.status;
  }

  /**
   * 播放/暂停
   */
  async setPlaying(playing = true) {
    const res = await this.runShell(
      playing ? "mphelper play" : "mphelper pause"
    );
    const success = res?.stdout.includes('"code": 0') ?? false;
    if (success) this.status = playing ? "playing" : "paused";
    return success;
  }

  /**
   * 在用户开始说话的瞬间先切断音箱当前的音频输出。
   *
   * OH2P 的 `mphelper mute_stat` 对 `tts_play.sh` 返回 idle，不能用状态
   * 判断是否需要暂停；因此唤醒路径会无条件调用这个方法，再由上层决定
   * 是暂停播客还是彻底结束 MiGPT TTS。
   */
  async interruptOutput() {
    // 使已经在等待 RPC/网络的旧 TTS 失效。仅调用 mphelper pause 会把音量
    // 压低，但不会阻止旧的 speaker.play() 在稍后拿到 PID 后继续输出。
    // 播客使用 mediaplayer 音乐队列，miplayer 只用于 MiGPT/原生语音和
    // 普通 URL 音频，因此这里可以安全地先清理 miplayer，再暂停队列。
    this.playbackGeneration += 1;
    this.ttsProcessActive = false;
    const res = await this.runShell(
      "killall tts_play.sh 2>/dev/null; killall miplayer 2>/dev/null; " +
      "killall -9 tts_play.sh 2>/dev/null; killall -9 miplayer 2>/dev/null; " +
      // 空闲时调用 mphelper pause 会把 mediaplayer 全局状态置为 paused，
      // 随后的原生 ai_service 虽然返回 Speak 事件，音频却可能被暂停状态
      // 吞掉。只有确实有音乐队列在播放时才暂停；原生 TTS 由后续
      // abortXiaoAI 负责清理，不需要操作 mediaplayer 状态。
      "if [ \"$(mphelper mute_stat 2>/dev/null)\" = \"1\" ]; then mphelper pause; fi",
    );
    if (res?.stdout.includes('"code": 0')) this.status = "paused";
    if (this.activePlayback === "tts") this.activePlayback = "idle";
    return res?.exit_code === 0;
  }

  /**
   * 停止并清理当前播放队列。OH2P 1.62.2 的 player_reset 返回成功却不清队列，
   * 实机验证只有重启 mediaplayer 后状态才会从 paused/playing 回到 idle。
   */
  async stop() {
    this.playbackGeneration += 1;
    // 仅重启 mediaplayer 不能保证同步等待中的 tts_play.sh 立即退出；
    // 先清理 MiGPT 启动的播放器进程，避免旧 AI 流继续播放后续片段。
    this.ttsProcessActive = false;
    // TERM 通常足够，但个别 1.62.2 固件上的 miplayer 会卡在网络读；
    // 追加一次 KILL，确保“停止”不会等到整段音频结束才真正静音。
    const res = await this.runShell("mphelper pause >/dev/null 2>&1; killall tts_play.sh 2>/dev/null; killall miplayer 2>/dev/null; sleep 0.05; killall -9 tts_play.sh 2>/dev/null; killall -9 miplayer 2>/dev/null; /etc/init.d/mediaplayer restart >/dev/null 2>&1");
    this.status = "idle";
    this.activePlayback = "idle";
    return res?.exit_code === 0;
  }

  /** 读取播放器上下文。OH2P 1.62.2 把 position/duration 放在 info.play_song_detail。 */
  async getPlaybackContext(): Promise<Record<string, unknown>> {
    const res = await this.runShell("ubus call mediaplayer player_get_play_status");
    if (!res?.stdout) return {};
    try {
      const response = JSON.parse(res.stdout) as Record<string, unknown>;
      const info = typeof response.info === "string"
        ? JSON.parse(response.info) as Record<string, unknown>
        : response.info as Record<string, unknown> | undefined;
      const detail = info?.play_song_detail;
      return detail && typeof detail === "object"
        ? { ...info, ...(detail as Record<string, unknown>) }
        : info || response;
    } catch (_) {
      return {};
    }
  }

  /** 将播放器跳转到毫秒位置。命令名称保持 OH2P 的实际拼写 player_set_positon。 */
  async seek(positionMs: number, media = "common") {
    const position = Math.max(0, process.env.MIGPT_POSITION_UNIT === "s"
      ? Math.round(positionMs / 1000)
      : Math.round(positionMs));
    const res = await this.runShell(
      `ubus call mediaplayer player_set_positon ${shellQuote(jsonEncode({ position, media }))}`
    );
    return res?.stdout.includes('"code": 0') ?? false;
  }

  /**
   * 播放文字、音频链接、音频流
   */
  async play({
    text,
    url,
    bytes,
    audioId,
    durationMs,
    timeout = 10 * 60 * 1000,
    blocking = false,
  }: {
    text?: string;
    url?: string;
    bytes?: Uint8Array;
    /** 播客节目稳定 ID，用于 OH2P 建立可 seek 的音乐播放上下文。 */
    audioId?: string;
    durationMs?: number | null;
    /**
     * 超时时长（毫秒）
     *
     * 默认 10 分钟
     */
    timeout?: number;
    /**
     * 是否阻塞运行(仅对播放文字、音频链接有效)
     *
     * 如果是则等到音频播放完毕才会返回
     */
    blocking?: boolean;
  }) {
    if (bytes) {
      return RustServer.on_output_data(bytes) as Promise<boolean>;
    }

    if (blocking) {
      const generation = this.playbackGeneration;
      this.activePlayback = "tts";
      this.ttsProcessActive = true;
      // MiGPT 自己的 TTS 会被音箱再次识别成 ASR；记录当前片段，交给
      // MicArbiter 在短时间内丢弃回声，但不影响用户的短控制指令。
      if (text) this.suppressMicEcho?.(15000, text);
      // 不能在 WebSocket RPC 中前台运行 tts_play.sh/miplayer：Rust 服务一次
      // 只处理一个 shell 请求，前台进程会把 stop/pause 命令堵在队列里，
      // 造成唤醒后仍继续播报数秒。后台启动后由 Node 轮询 PID，stop 即可
      // 在轮询间隙送达并 kill 播放进程。
      const command = url
        ? `miplayer -f ${shellQuote(url)} >/dev/null 2>&1 & echo $!`
        : `/usr/sbin/tts_play.sh ${shellQuote(text || "你好")} >/dev/null 2>&1 & echo $!`;
      const launch = await this.runShell(command);
      const pid = launch?.stdout.trim().match(/\d+/)?.[0];
      if (!pid) {
        if (text) this.suppressMicEcho?.(2500, text);
        if (generation === this.playbackGeneration) {
          this.ttsProcessActive = false;
          this.activePlayback = "idle";
        }
        return false;
      }
      // stop() 与启动命令可能同时通过 WebSocket 发往音箱：若 stop 的
      // killall 先返回、旧响应随后才拿到 PID，必须在这里再次检查并清掉
      // 这个迟到的进程，避免它在用户已经唤醒后继续播报。
      if (generation !== this.playbackGeneration) {
        await this.runShell(`kill ${pid} 2>/dev/null; killall tts_play.sh 2>/dev/null; killall miplayer 2>/dev/null`);
        if (text) this.suppressMicEcho?.(2500, text);
        return false;
      }
      let completed = false;
      const deadline = Date.now() + timeout;
      while (generation === this.playbackGeneration && Date.now() < deadline) {
        const probe = await this.runShell(
          `if kill -0 ${pid} 2>/dev/null; then echo alive; else echo done; fi`,
          { timeout: 2_000 },
        );
        if (!probe?.stdout.includes("alive")) {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (generation !== this.playbackGeneration) {
        await this.runShell(`kill ${pid} 2>/dev/null; killall tts_play.sh 2>/dev/null; killall miplayer 2>/dev/null`);
      }
      if (text) this.suppressMicEcho?.(2500, text);
      if (generation === this.playbackGeneration) {
        this.ttsProcessActive = false;
        this.activePlayback = "idle";
      }
      return generation === this.playbackGeneration && completed;
    }

    const resolvedAudioId = audioId || (url
      ? createHash("sha1").update(url).digest("hex").slice(0, 20)
      : "");
    const music = url ? {
      payload: {
        audio_type: "MUSIC",
        audio_items: [{
          item_id: {
            audio_id: resolvedAudioId,
            cp: {
              album_id: "-1",
              episode_index: 0,
              id: resolvedAudioId,
              name: "xiaowei",
            },
          },
          stream: { url },
        }],
        list_params: {
          listId: "-1",
          loadmore_offset: 0,
          origin: "xiaowei",
          type: "MUSIC",
        },
      },
      play_behavior: "REPLACE_ALL",
    } : undefined;
    const res = await this.runShell(
      url
        // OH2P 使用 player_play_url 时会把音频当作 TTS，既不返回进度也无法 seek。
        // player_play_music 会建立 play_song_detail，实机 1.62.2 已验证可暂停和跳转。
        ? `ubus call mediaplayer player_play_music ${shellQuote(jsonEncode({
            music: JSON.stringify(music),
            startaudioid: resolvedAudioId,
            startOffset: 0,
            media: "common",
            src: "migpt",
            id: resolvedAudioId,
            duration: Math.max(0, Math.round(durationMs || 0)),
          }))}`
        : `ubus call mibrain text_to_speech ${shellQuote(jsonEncode({
            text: text || "你好",
            save: 0,
          }))}`,
      { timeout }
    );
    const success = res?.stdout.includes('"code": 0') ?? false;
    if (success && url) {
      this.status = "playing";
      this.activePlayback = "media";
    }
    return success;
  }

  /**
   * （取消）唤醒小爱
   */
  async wakeUp(
    awake = true,
    options?: {
      /**
       * 静默唤醒
       */
      silent: boolean;
    }
  ) {
    const { silent = true } = options ?? {};
    const command = awake
      ? silent
        ? `ubus call pnshelper event_notify '{"src":1,"event":0}'`
        : `ubus call pnshelper event_notify '{"src":0,"event":0}'`
      : `
        ubus call pnshelper event_notify '{"src":3, "event":7}'
        sleep 0.1
        ubus call pnshelper event_notify '{"src":3, "event":8}'
    `;
    const res = await this.runShell(command);
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 把文字指令交给原来的小爱执行
   */
  async askXiaoAI(
    text: string,
    options?: {
      /**
       * 静默执行
       */
      silent: boolean;
    }
  ) {
    const { silent = false } = options ?? {};
    // 独占麦克风模式只拦截云端自动 NLP；直接调用 mibrain.ai_service 仍可
    // 正常生成原生回复。保持 /data/pns.lab 不变，避免临时重启
    // mico_aivs_lab 破坏下一轮连续对话的 Wakeup/ASR 会话。
    const generation = ++this.nativeRequestGeneration;
    console.log("🗣️ 原生请求开始", { text, generation, exclusiveMic: this.exclusiveMic });
    this.nativeReplyInProgress = !silent;
    this.nativeReplyTtsStarted = false;
    this.nativeReplyDialogId = undefined;
    try {
      if (generation !== this.nativeRequestGeneration) return false;
      // 原生 TTS 由 mico_aivs_lab 直接驱动音频输出，不属于 mediaplayer
      // 队列。不要在提交 ai_service 前调用 mphelper play：该调用会重置
      // OH2P 的播放器状态，反而可能让已生成的 Speak 被吞掉；播客恢复由
      // PodcastController 单独处理。
      // ai_service 可能返回 code=-1（服务尚未就绪）；这里不自动重发，
      // 因为 OH2P 会把已经提交的请求留在队列中，重发会造成串音。
      const request = `ubus call mibrain ai_service ${shellQuote(jsonEncode({
        tts: silent ? undefined : 1,
        nlp: 1,
        nlp_text: text,
      }))}`;
      // 强制重启 mico_aivs_lab 后，服务需要短暂恢复 IPC。此阶段返回的
      // code=-1 表示“尚未就绪”，请求尚未入队，可以安全重试；与 code=0
      // 后等待 TTS 超时不同，后者绝不能重复提交。
      let res: CommandResult | undefined;
      for (const delay of [0, 400, 800, 1200, 1600]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (generation !== this.nativeRequestGeneration) return false;
        res = await this.runShell(request);
        if (!res?.stdout.includes('"code": -1')) break;
        if (delay) console.warn("⚠️ 原生小爱服务尚未就绪，等待后重试", { text, delay });
      }
      const success = res?.exit_code === 0 && Boolean(res?.stdout?.includes('"code": 0'));
      let dialogId: string | undefined;
      if (success) {
        try {
          const outer = JSON.parse(res?.stdout || "{}") as { info?: string };
          const info = JSON.parse(outer.info || "{}") as { dialog_id?: string };
          dialogId = info.dialog_id;
          this.nativeReplyDialogId = dialogId;
          this.nativeReplyTtsStarted = false;
        } catch (_) {
          // 兼容固件返回非 JSON info。
        }
      }
      console.log("🗣️ 原生请求响应", { text, generation, success, dialogId, exitCode: res?.exit_code, stdout: res?.stdout?.trim() });
      if (generation !== this.nativeRequestGeneration) return false;
      if (success && !silent && dialogId) {
        const started = await this.waitForNativeTtsStart(dialogId, generation);
        if (!started) {
          // ai_service 的请求已经进入固件队列，不能再次提交同一文本；
          // 延迟到达的旧响应会与重试交叉播放，这是“重复天气/只播几字”
          // 的主要原因。只记录失败，等待用户下一次明确指令。
          console.warn("⚠️ 原生请求已入队但 TTS 未启动", { text, generation, dialogId });
          this.nativeReplyInProgress = false;
          this.nativeReplyTtsStarted = false;
          this.nativeReplyDialogId = undefined;
          return false;
        }
      }
      if (!success && !silent) {
        // RPC 超时或 code=-1 时，也必须释放“待处理”状态；
        // 否则下一次普通唤醒会被误判为需要中断一条不存在的回复。
        this.nativeReplyInProgress = false;
        this.nativeReplyTtsStarted = false;
        this.nativeReplyDialogId = undefined;
      }
      console.log(`🔥 原生小爱转发${success && (silent || this.nativeReplyTtsStarted) ? "成功" : "失败"}`, {
        text,
        exit_code: res?.exit_code,
        stdout: res?.stdout?.trim(),
        stderr: res?.stderr?.trim(),
        tts_started: this.nativeReplyTtsStarted,
      });
      if (success && !silent) {
        // ai_service 只负责提交请求，实际 TTS 在音箱后台播放。不要在这里
        // 同步等待播放器结束：旧实现最多等待 20 秒，导致 messageQueue
        // 阻塞，用户第二次唤醒说“几点了”时指令只能排队，表现为第一遍
        // 没有回复。后台等待结束后再恢复独占麦克风；新一轮唤醒会通过
        // nativeRequestGeneration 取消这个等待。
        void this.waitForNativeReply(undefined, generation).then(async () => {
          if (generation !== this.nativeRequestGeneration) return;
          console.log("🗣️ 原生回复播放结束", { generation });
          this.nativeReplyInProgress = false;
        }).catch((error) => {
          if (generation === this.nativeRequestGeneration) {
            this.nativeReplyInProgress = false;
            console.warn("⚠️ 等待原生小爱回复结束失败", error);
          }
        });
      }
      return success;
    } finally {
      // 成功且需要恢复独占时由上面的后台任务负责清理；否则立即恢复。
      if (generation === this.nativeRequestGeneration && silent) {
        this.nativeReplyInProgress = false;
      }
    }
  }

  /** 由 instruction.log 的 Speak/SpeakStream 事件确认原生 TTS 已真正启动。 */
  markNativeTtsStarted(dialogId?: string) {
    if (!dialogId || dialogId !== this.nativeReplyDialogId) return false;
    this.nativeReplyTtsStarted = true;
    this.nativeReplyInProgress = true;
    return true;
  }

  /** 只结束与当前 ai_service 对应的原生回复。 */
  markNativeTtsFinished(dialogId?: string) {
    if (!dialogId || dialogId !== this.nativeReplyDialogId) return false;
    this.nativeReplyInProgress = false;
    return true;
  }

  async waitForNativeTtsStart(
    dialogId: string,
    generation: number,
    // ai_service 返回的是“入队成功”，OH2P 可能要几秒才写入 Speak。
    // 默认等待 15 秒；不能在 4 秒时重发同一条请求，因为旧请求仍在
    // 固件队列中，重试会导致重复/交叉播报。
    timeoutMs = Number(process.env.MIGPT_NATIVE_TTS_START_TIMEOUT_MS || 15000),
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (generation !== this.nativeRequestGeneration || dialogId !== this.nativeReplyDialogId) return false;
      if (this.nativeReplyTtsStarted) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.nativeReplyTtsStarted;
  }

  /** 清空 OH2P 偶发卡死的原生 NLP/TTS 队列，为一次受控重试做准备。 */
  async recoverNativeService(generation: number) {
    if (generation !== this.nativeRequestGeneration) return false;
    const res = await this.runShell(
      // init.d restart 在 1.62.2 上可能只给 mico_aivs_lab 发送 TERM，
      // 已经从云端取到的 TTS 仍会继续排队播放。先强制结束旧进程，
      // 再交给 procd 拉起服务，确保迟到的旧回复不会串到下一条指令。
      "killall -9 mico_aivs_lab 2>/dev/null; sleep 0.2; /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1; sleep 1; echo MIGPT_NATIVE_RECOVERED",
      { timeout: 5000 },
    );
    return generation === this.nativeRequestGeneration && Boolean(res?.stdout.includes("MIGPT_NATIVE_RECOVERED"));
  }

  async waitForNativeReply(beforeStatus?: string, generation = this.nativeRequestGeneration) {
    // 给 TTS 请求留出启动时间。OH2P 的 mute_stat 对云端流式 TTS 可能始终
    // 返回 idle，因此不能用播放器状态判断结束；xiaoai.ts 会在收到
    // FinishSpeakStream 时清除 nativeReplyInProgress。
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (generation !== this.nativeRequestGeneration) return;
    // 最长等待 60 秒仅作为异常兜底（例如固件丢失 FinishSpeakStream），
    // 正常回复会在事件到达后立即返回。保留 beforeStatus 参数以兼容调用方。

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (generation !== this.nativeRequestGeneration) return;
      if (!this.nativeReplyInProgress) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * 中断原来小爱的运行
   *
   * 注意：重启需要大约 1-2s 的时间，在此期间无法使用小爱音箱自带的 TTS 服务
   */
  async abortXiaoAI(
    force = false,
    options?: { restartService?: boolean },
  ) {
    // 原生小爱正在回答时，新的 ASR（尤其是“停止/暂停”）必须能够抢回
    // 播放控制权；普通的 MiGPT 确认语音仍使用默认的非强制路径。
    if (this.nativeReplyInProgress && !force) return true;
    if (this.exclusiveMic && !force) return true;
    // ASR 回调和播客确认语音可能在同一条指令内连续触发，普通路径短窗口
    // 内只重启一次；force 用于用户再次唤醒/说“停止”，必须无条件执行，
    // 否则刚重启过服务的 2 秒窗口内原生 TTS 仍会继续播放。
    if (!force && Date.now() - this.lastAbortAt < 2000) return true;
    // force 既用于打断已记录的原生 TTS，也用于在最终 ASR 后结束固件
    // 可能偷偷启动的隐式 NLP。独占麦克风已由 /data/pns.lab 隔离；只有
    // 确实存在正在播放的原生回复时才需要重启 mico_aivs_lab 清空队列。
    // 必须在下面清空状态前锁存。独占麦克风仅表示 /data/pns.lab 由 MiGPT
    // 管理，不代表此刻存在需要通过重启服务清理的原生 TTS。
    const hadNativeReply = this.nativeReplyInProgress;
    const restoreExclusiveMic = force && (hadNativeReply || this.exclusiveMic);
    // 结束最终 ASR 会话时只需要发送 event_notify，不应为了每一条普通指令
    // 重启 mico_aivs_lab。重启会让 ai_service 在约 1~2 秒内返回 code=-1，
    // 造成天气/时间首句无声；只有确实存在正在播放的原生回复时才清理进程。
    // 普通 FINAL ASR 只需结束本轮收音。此前把 exclusiveMic 也当成重启
    // 条件，导致每次问天气/时间都杀掉并拉起 mico_aivs_lab；指令文本虽然
    // 完整写入日志，刚恢复的音频流却可能只播出开头。只有正在打断上一条
    // 原生回复时才重启服务清空旧 TTS 队列。
    const restartService = options?.restartService ?? hadNativeReply;
    if (force) {
      this.nativeRequestGeneration += 1;
      this.nativeReplyInProgress = false;
      this.nativeReplyTtsStarted = false;
      // 旧 dialog 已被中断并清理，后续迟到的 Speak/Exception 事件不能再
      // 误关联到新一轮原生请求。
      this.nativeReplyDialogId = undefined;
      this.nativeReplySourceDialogId = undefined;
    }
    this.lastAbortAt = Date.now();
    const startedAt = Date.now();
    console.log("🛑 开始中断原生小爱", {
      force,
      restoreExclusiveMic,
      restartService,
      generation: this.nativeRequestGeneration,
    });
    const res = await this.runShell(
      // 先用 pnshelper 结束收音会话。仅 event_notify 无法清除已经排队的
      // TTS；在确实中断原生回复时，下面会强制重启 mico_aivs_lab，
      // 避免旧回复在新指令之后继续播放。此时暂不恢复 pns.lab，由下一条
      // 原生回复结束后的后台任务恢复。
      // 某些 1.62.2 状态下 event_notify 会等待旧会话释放；放到后台并只
      // 留出 200ms 给服务切换，不能让 Node 的 ASR 事件队列被它阻塞。
      "(ubus call pnshelper event_notify '{\"src\":3,\"event\":7}' >/dev/null 2>&1 &) ; " +
      "sleep 0.1; " +
      "(ubus call pnshelper event_notify '{\"src\":3,\"event\":8}' >/dev/null 2>&1 &) ; " +
      // event_notify 只能结束收音会话，不能清掉已经排队的原生 TTS。
      // 当确实存在上一条原生回复时，最终 ASR 已经落盘，安全重启
      // mico_aivs_lab 清空旧队列；否则下一条 ai_service 会和旧天气同时播报。
      (restartService
        // 1.62.2 启动 mico_aivs_lab 后约 1.5 秒才可稳定接受 ai_service；
        // 等待时间不足会让下一条请求返回 code=-1。
        ? "sleep 0.2; killall -9 mico_aivs_lab 2>/dev/null; sleep 0.2; /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1; sleep 2; "
        : "sleep 0.2; ") +
      "echo MIGPT_ABORT_SENT",
      { timeout: restartService ? 5_000 : 800 },
    );
    console.log("🛑 原生小爱中断命令完成", { elapsedMs: Date.now() - startedAt, exitCode: res?.exit_code });
    const success = res?.exit_code === 0;
    // 中断原生回复只结束当前 dialog，不应关闭 MiGPT 的独占麦克风标记。
    // 旧代码在这里写成 false，导致第一次天气请求后后续 ASR 又被固件
    // 自动送入原生 NLP，出现 code=111、重复抢麦以及“几点了”无声。
    if (success && restoreExclusiveMic && this.exclusiveMicManaged) {
      this.exclusiveMic = true;
    }
    return success;
  }

  /**
   * 让小米云只返回 ASR 文本，不再执行原生 NLP/TTS。
   * OH2P 的 mico_aivs_lab 在 /data/pns.lab 存在时会进入内置实验模式；
   * 该模式会保留 RecognizeResult，但在请求中禁用原生 NLP 与 TTS。
   */
  async setExclusiveMic(enabled = true) {
    const marker = "# managed by open-xiaoai MiGPT";
    const script = enabled
      ? `
        if [ -e /data/pns.lab ] && ! grep -qxF '${marker}' /data/pns.lab; then
          echo MIGPT_EXCLUSIVE_CONFLICT
          exit 2
        fi
        if [ ! -e /data/pns.lab ]; then
          printf '%s\\n' '${marker}' > /data/pns.lab
          timeout -t 4 /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1 || true
          echo MIGPT_EXCLUSIVE_RESTARTED
        fi
        echo MIGPT_EXCLUSIVE_OK
      `
      : `
        if [ -f /data/pns.lab ] && grep -qxF '${marker}' /data/pns.lab; then
          rm -f /data/pns.lab
          timeout -t 4 /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1 || true
          echo MIGPT_EXCLUSIVE_RESTARTED
        fi
        echo MIGPT_EXCLUSIVE_OK
      `;
    const res = await this.runShell(script);
    const success = res?.stdout.includes("MIGPT_EXCLUSIVE_OK") ?? false;
    if (success && res?.stdout.includes("MIGPT_EXCLUSIVE_RESTARTED")) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    this.exclusiveMic = enabled && success;
    if (enabled && success) this.exclusiveMicManaged = true;
    if (this.exclusiveMic) this.lastAbortAt = Date.now();
    return success;
  }

  /**
   * 获取启动分区
   */
  async getBoot() {
    const res = await this.runShell("echo $(fw_env -g boot_part)");
    return res?.stdout.trim();
  }

  /**
   * 设置启动分区
   */
  async setBoot(boot_part: "boot0" | "boot1") {
    const res = await this.runShell(
      `fw_env -s boot_part ${boot_part} >/dev/null 2>&1 && echo $(fw_env -g boot_part)`
    );
    return res?.stdout.includes(boot_part);
  }

  /**
   * 获取设备型号、序列号信息
   */
  async getDevice() {
    const res = await this.runShell("echo $(micocfg_model) $(micocfg_sn)");
    const info = res?.stdout.trim().split(" ");
    return {
      model: info?.[0] ?? "unknown",
      sn: info?.[1] ?? "unknown",
    };
  }

  /**
   * 获取麦克风状态
   */
  async getMic() {
    const res = await this.runShell(
      "[ ! -f /tmp/mipns/mute ] && echo on || echo off"
    );
    let status: "on" | "off" = "off";
    if (res?.stdout.includes("on")) {
      status = "on";
    }
    return status;
  }

  /**
   * 打开/关闭麦克风
   */
  async setMic(on = true) {
    const res = await this.runShell(
      on
        ? `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":7}' 2>&1`
        : `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":8}' 2>&1`
    );
    return res?.stdout.includes('"code":0');
  }

  /**
   * 执行脚本
   */
  async runShell(
    script: string,
    options?: {
      /**
       * 超时时间（单位：毫秒）
       */
      timeout?: number;
    }
  ): Promise<CommandResult | undefined> {
    const { timeout = 10 * 1000 } = options ?? {};
    try {
      const res = await RustServer.run_shell(script, timeout);
      if (res) {
        return JSON.parse(res);
      }
    } catch (_) {
      return undefined;
    }
  }
}

export const OpenXiaoAISpeaker = new SpeakerManager();
