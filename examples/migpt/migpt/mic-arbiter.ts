/** 小爱原生服务与 MiGPT 的单麦仲裁，按最终 ASR 文本去重并抢先中断原生 NLP。 */
export class MicArbiter {
  private lastText = "";
  private lastAt = 0;
  private suppressedUntil = 0;
  private suppressedText = "";
  private spokenTexts: Array<{ text: string; until: number }> = [];
  private lastDialogId = "";

  // OH2P 在网络请求较慢时可能每隔数秒重复上报同一条最终 ASR；窗口需要
  // 覆盖一次播客指令的处理时间，避免“下一集”被并发执行多次。
  constructor(private readonly exclusive = true, private readonly duplicateWindowMs = 10000) {}

  private normalize(text: string) {
    return text
      .replace(/博\s*客|波\s*客|播\s*克|波\s*克/g, "播客")
      .replace(/(播放|播)\s*过客/g, "$1播客")
      .replace(/播\s*客/g, "播客")
      .replace(/[零〇一二两三四五六七八九]/g, (char) =>
        ({ 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" } as Record<string, string>)[char] || char
      );
  }

  isDuplicate(text: string, dialogId?: string) {
    const now = Date.now();
    const normalized = this.normalize(text);
    const suppressed = this.normalize(this.suppressedText);
    this.spokenTexts = this.spokenTexts.filter((entry) => entry.until > now);
    // 固件对同一轮识别偶尔会重复写入 FINAL；同一 dialog 只处理一次。
    // 不再按“文本 + 时间窗口”丢弃不同轮次的短指令，否则用户连续两次
    // 询问“几点了”或“天气”会被误认为回声而没有回复。
    if (dialogId) {
      const sameDialog = dialogId === this.lastDialogId;
      this.lastDialogId = dialogId;
      if (sameDialog) return true;
    }
    if (now < this.suppressedUntil) {
      // 音箱回传的 ASR 可能只是当前 TTS 片段的一部分；长文本采用包含关系
      // 去重，但保留“停止/暂停/下一集”等短控制词，确保用户能打断回答。
      const recentEcho = this.spokenTexts.some((entry) =>
        normalized === entry.text || (normalized.length >= 8 && entry.text.length >= 8 &&
          (normalized.includes(entry.text) || entry.text.includes(normalized)))
      );
      const echo = !suppressed || normalized === suppressed || recentEcho || (
        normalized.length >= 8 && suppressed.length >= 8 &&
        (normalized.includes(suppressed) || suppressed.includes(normalized))
      );
      if (echo) return true;
    }
    const duplicate = !dialogId && normalized.length >= 8 && normalized === this.lastText && now - this.lastAt < this.duplicateWindowMs;
    this.lastText = normalized;
    this.lastAt = now;
    return duplicate;
  }

  /** MiGPT 播放确认语音期间，忽略音箱把自己的回声再次识别出来的结果。 */
  suppressFor(milliseconds = 20000, text = "") {
    const until = Date.now() + milliseconds;
    this.suppressedUntil = Math.max(this.suppressedUntil, until);
    this.suppressedText = text;
    if (text) this.spokenTexts.push({ text: this.normalize(text), until });
  }

  shouldAbortNative() { return this.exclusive; }
}
