import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { AppConfig } from "../config.js";
import { createCustomResponsesModel } from "./model.js";
import { buildEnglishCoachPrompt } from "../prompts/englishCoach.js";
import { createBashTool } from "../tools/bashTool.js";

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text?: string } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

export class PiEnglishCoach {
  private readonly agent: Agent;

  constructor(private readonly config: AppConfig) {
    this.agent = new Agent({
      initialState: {
        systemPrompt: buildEnglishCoachPrompt(config),
        model: createCustomResponsesModel(config),
        thinkingLevel: config.openaiReasoning,
        tools: [createBashTool(config)],
      },
      getApiKey: async (provider) => {
        if (provider === "crs") return config.crsApiKey;
        return undefined;
      },
      toolExecution: "sequential",
    });
  }

  subscribe(logger: (event: AgentEvent) => void): void {
    this.agent.subscribe((event) => {
      logger(event);
    });
  }

  async runTurn(userText: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error("Agent 推理已取消");

    const abortHandler = (): void => {
      this.agent.abort();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      await this.agent.prompt(userText);
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }

    if (signal?.aborted) throw new Error("Agent 推理已取消");
    const lastAssistant = [...this.agent.state.messages].reverse().find((message) => message.role === "assistant");
    if (!lastAssistant) {
      throw new Error("未找到 Agent 最终回复");
    }
    return extractAssistantText(lastAssistant.content).trim();
  }
}
