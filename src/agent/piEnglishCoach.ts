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

  async runTurn(userText: string): Promise<string> {
    await this.agent.prompt(userText);
    const lastAssistant = [...this.agent.state.messages].reverse().find((message) => message.role === "assistant");
    if (!lastAssistant) {
      throw new Error("未找到 Agent 最终回复");
    }
    return extractAssistantText(lastAssistant.content).trim();
  }
}
