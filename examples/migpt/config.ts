import { OpenXiaoAIConfig } from "./migpt/xiaoai.js";

export const kOpenXiaoAIConfig: OpenXiaoAIConfig = {
  openai: {
    /**
     * 你的大模型服务提供商的接口地址
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     * - ✅ https://api.openai.com/v1
     * - ❌ https://api.openai.com/v1/（最后多了一个 /
     * - ❌ https://api.openai.com/v1/chat/completions（不需要加 /chat/completions）
     */
    // OpenAI 地址、密钥和模型首次启动时均为空，需在管理页面配置并保存到 /data/config.json。
    baseURL: "",
    /**
     * API 密钥
     */
    apiKey: "",
    /**
     * 模型名称
     */
    model: "",
  },
  prompt: {
    /**
     * 系统提示词，如需关闭可设置为：''（空字符串）
     */
    // 使用 ?? 保留显式空字符串；这样可以通过环境变量关闭系统提示词。
    system: process.env.MIGPT_SYSTEM_PROMPT ?? "你是一个智能助手，请根据用户的问题给出回答。",
  },
  /**
   * 只回答以下关键词开头的消息：
   *
   * - 请问地球为什么是圆的？
   * - 你知道世界上跑的最快的动物是什么吗？
   */
  callAIKeywords: ["请问", "你知道"],
  podsuite: {
    // PodSuite 地址和集成 Token 需在管理页面配置并保存到 /data/config.json。
    url: "",
    token: "",
  },
  /**
   * 自定义消息回复
   */
  async onMessage(engine, { text }) {
    const normalizedText = text.trim();
    if (engine.podcastController) {
      const podcastResult = await engine.podcastController.handle(text);
      if (podcastResult.handled) return podcastResult;
    }
    // OH2P 偶尔会在用户仍在说话时提前上报一个只有“播放”的 FINAL。
    // 这不是完整的原生音乐指令，不能立刻调用 ai_service，否则会与后续
    // “播放播客××”并发，出现原生小爱和 MiGPT 同时出声。等待下一轮完整语音。
    if (/^(?:播放|播|听|收听)(?:播客|博客|波客|播克)?$/.test(normalizedText)) {
      return { handled: true };
    }
    if (text === "测试播放文字") {
      return { text: "你好，很高兴认识你！" };
    }

    if (text === "测试播放音乐") {
      return { url: "https://xxx.com/1.mp3" };
    }

    if (text === "测试其他能力") {
      // 打断原来小爱的回复
      await engine.speaker.abortXiaoAI();

      // 播放文字
      await engine.speaker.play({ text: "你好，很高兴认识你！", blocking: true });

      // 播放音频链接
      await engine.speaker.play({ url: "https://example.com/hello.mp3" });

      // 告诉 MiGPT 已经处理过这条消息了，不再使用默认的 AI 回复
      return { handled: true };
    }

    // AI 已经回答过问题时，OH2P 会在连续对话窗口内直接上报下一句，
    // 后续句子通常没有“请问/你知道”前缀。让它继续走 MiGPT；天气、时间、
    // 音量和设备控制仍明确交给原生小爱，避免被独占麦克风模式吞掉。
    const nativeCommand = /^(?:天气|气温|温度|几点|现在几点|时间|日期|音量|调高音量|调低音量|播放音乐|听音乐|暂停音乐|继续播放音乐|打开|关闭|开启|关掉|设置闹钟|提醒我|蓝牙|电台)/.test(normalizedText);
    if (engine.shouldContinueAI() && !nativeCommand) {
      if (!engine.isAIConfigured()) return { text: "请先打开 4398 管理页面，在配置中填写模型接口、模型和 API Key。" };
      return { default: true };
    }

    if (/^(?:请问|你知道)/.test(normalizedText) && !engine.isAIConfigured()) {
      return { text: "请先打开 4398 管理页面，在配置中填写模型接口、模型和 API Key。" };
    }

    // 播客之外的音乐、天气和设备控制只显式交给原生小爱一次。
    // “请问…”、“你知道…”仍由上面的 callAIKeywords 交给大模型回答。
    if (!/^(?:请问|你知道)/.test(text)) {
      await engine.speaker.askXiaoAI(text);
      return { handled: true };
    }
  },
};
