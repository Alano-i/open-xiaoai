/** MiGPT 播客集成使用的目录、节目和播放状态类型。 */
export interface Podcast {
  id?: string;
  book_title: string;
  author?: string;
  reader?: string;
  podcast_url?: string;
  cover_url?: string;
  audio_num?: number;
}

export interface Episode {
  episode_id: string;
  podcast_id: string;
  podcast_title: string;
  title: string;
  season: number;
  episode: number;
  audio_url: string;
  duration_ms?: number | null;
  previous_episode_id?: string | null;
  next_episode_id?: string | null;
  progress?: Progress | null;
}

export interface Progress {
  episode_id: string;
  position_ms: number;
  duration_ms?: number | null;
  status: string;
  device_id?: string;
  updated_at?: string;
}
