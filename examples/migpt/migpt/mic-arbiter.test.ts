import assert from "node:assert/strict";
import test from "node:test";
import { MicArbiter } from "./mic-arbiter.js";

test("过滤 MiGPT 长文本回声但保留短控制词", () => {
  const arbiter = new MicArbiter(true);
  arbiter.suppressFor(10_000, "量子计算是一种利用量子力学规律处理信息的计算方式");
  assert.equal(arbiter.isDuplicate("量子计算是一种利用量子力学规律"), true);
  assert.equal(arbiter.isDuplicate("停止"), false);
});
