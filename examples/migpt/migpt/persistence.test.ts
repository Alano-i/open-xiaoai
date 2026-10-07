/** 对话记录数量上限回归测试：只保留最近 100 条，旧文件超量时加载即裁剪。 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationStore } from "./persistence.js";

test("对话记录只保留最近 100 条，超过时删除最早的", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migpt-conversations-"));
  const file = join(dir, "conversations.json");
  try {
    // 旧版本留下的 500 条记录。
    writeFileSync(file, JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ text: `旧记录${index}` }))));
    const store = new ConversationStore(file);
    await store.load();
    let entries = store.list();
    assert.equal(entries.length, 100);
    assert.equal(entries[0]?.text, "旧记录499", "列表按时间倒序，最新的在前");
    assert.equal(entries.at(-1)?.text, "旧记录400");

    store.append({ text: "新记录" });
    await store.flush();
    entries = store.list();
    assert.equal(entries.length, 100);
    assert.equal(entries[0]?.text, "新记录");
    assert.equal(entries.at(-1)?.text, "旧记录401", "超过上限时覆盖最早的一条");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 100, "写入文件的也只有 100 条");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
