/** PodSuite 播客 API 客户端，所有网络访问集中在此处便于替换和测试。 */
import type { Episode, Podcast, Progress } from "./types.js";

export interface PodcastApiConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class PodcastApiClient {
  constructor(private config: PodcastApiConfig) {}

  updateConfig(config: PodcastApiConfig) { this.config = config; }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.config.baseUrl.trim()) {
      throw new Error("未配置 PodSuite 地址，请先在 MiGPT 管理页面保存配置");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10000);
    try {
      const headers = new Headers(init?.headers);
      headers.set("Accept", "application/json");
      if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const payload = (await response.json()) as { data?: T; message?: string };
      if (!response.ok || payload.data === undefined) {
        throw new Error(payload.message || `PodSuite 请求失败（${response.status}）`);
      }
      return payload.data;
    } finally {
      clearTimeout(timer);
    }
  }

  searchPodcasts(query: string) {
    return this.request<Podcast[]>(`/api/integrations/migpt/v1/podcasts?q=${encodeURIComponent(query)}`);
  }

  async resolveEpisodes(query: string, season?: number, episode?: number): Promise<Episode[]> {
    const params = new URLSearchParams({ q: query });
    params.set("all", "true");
    if (season) params.set("season", String(season));
    if (episode) params.set("episode", String(episode));
    let result = await this.request<Episode | Episode[]>(`/api/integrations/migpt/v1/episodes/search?${params}`);
    // 兼容尚未升级的 PodSuite（旧接口只返回单个对象）。
    let matches = Array.isArray(result) ? result : [result];
    if (!matches.length && season && episode && episode < 100) {
      // 部分 RSS 将每季编号写成全局编号（第 5 季第 3 集记录为 503），
      // 而语音习惯使用季内编号。精确查询无结果时自动尝试全局编号。
      // 该 RSS 第一季有 200 集，第二季起采用 201/301/501… 的全局编号。
      const fallbackEpisode = season === 1 ? episode : season * 100 + episode;
      if (fallbackEpisode !== episode) {
        const fallback = new URLSearchParams({ q: query, season: String(season), episode: String(fallbackEpisode), all: "true" });
        result = await this.request<Episode | Episode[]>(`/api/integrations/migpt/v1/episodes/search?${fallback}`);
        matches = Array.isArray(result) ? result : [result];
        if (matches.length) matches = matches.map((item) => ({ ...item, episode }));
      }
    }
    return matches;
  }

  async resolveEpisode(query: string, season?: number, episode?: number) {
    const params = new URLSearchParams({ q: query });
    if (season) params.set("season", String(season));
    if (episode) params.set("episode", String(episode));
    let result = await this.request<Episode | []>(`/api/integrations/migpt/v1/episodes/search?${params}`);
    if (Array.isArray(result) && !result.length && season && episode && episode < 100) {
      const fallbackEpisode = season === 1 ? episode : season * 100 + episode;
      if (fallbackEpisode !== episode) {
        const fallback = new URLSearchParams({ q: query, season: String(season), episode: String(fallbackEpisode) });
        result = await this.request<Episode | []>(`/api/integrations/migpt/v1/episodes/search?${fallback}`);
        if (!Array.isArray(result)) return { ...result, episode };
      }
    }
    return result;
  }

  getEpisode(episodeId: string) {
    return this.request<Episode>(`/api/integrations/migpt/v1/episodes/${encodeURIComponent(episodeId)}`);
  }

  getCurrentProgress() {
    return this.request<Progress | null>("/api/integrations/migpt/v1/playback/current");
  }

  getHistory() {
    return this.request<Progress[]>("/api/integrations/migpt/v1/playback/history");
  }

  saveProgress(episodeId: string, progress: Omit<Progress, "episode_id">) {
    return this.request<Progress>(`/api/integrations/migpt/v1/playback/${encodeURIComponent(episodeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(progress),
    });
  }

  complete(episodeId: string, deviceId = "") {
    return this.request<Progress>(`/api/integrations/migpt/v1/playback/${encodeURIComponent(episodeId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position_ms: 0, device_id: deviceId }),
    });
  }
}
