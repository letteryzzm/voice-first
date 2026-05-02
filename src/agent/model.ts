import type { Model } from "@mariozechner/pi-ai";
import type { AppConfig } from "../config.js";

export function createCustomResponsesModel(config: AppConfig): Model<"openai-responses"> {
  return {
    id: config.openaiModel,
    name: `${config.openaiModel} (CRS)` ,
    api: "openai-responses",
    provider: "crs",
    baseUrl: config.openaiBaseUrl,
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 32000,
    compat: {},
  };
}
