/** MiGPT 独立服务的轻量 JSON 持久化：配置、设备和对话审计均保存在挂载目录。 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class JsonStore<T extends object> {
  private value: T;
  constructor(private readonly file: string, initial: T) { this.value = initial; }

  async load(): Promise<T> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as T;
      if (parsed && typeof parsed === "object") this.value = parsed;
    } catch (_) { /* 首次运行使用默认值 */ }
    return this.value;
  }

  get data() { return this.value; }

  async save(next: T = this.value) {
    this.value = next;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.value, null, 2), "utf8");
    await rename(temporary, this.file);
  }
}

export class ConversationStore {
  private entries: Array<Record<string, unknown>> = [];
  constructor(private readonly file: string, private readonly limit = 500) {}
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch (_) { /* ignore */ }
  }
  append(entry: Record<string, unknown>) {
    this.entries.push({ id: randomUUID(), at: new Date().toISOString(), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    void this.flush().catch((error: unknown) => console.error("❌ 对话记录保存失败", error));
  }
  list() { return [...this.entries].reverse(); }
  async flush() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.entries, null, 2), "utf8");
  }
}
