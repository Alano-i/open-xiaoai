import { kOpenXiaoAIConfig } from "config.js";
import { OpenXiaoAI } from "./xiaoai.js";

async function main() {
  await OpenXiaoAI.start(kOpenXiaoAIConfig);
}

main();
