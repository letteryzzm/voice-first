import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AppConfig } from "../config.js";

const bashParameters = Type.Object({
  label: Type.String({ description: "一句话说明这条命令要做什么" }),
  command: Type.String({ description: "要执行的 bash 命令" }),
  timeoutSeconds: Type.Optional(Type.Number({ description: "超时时间，单位秒" })),
});

const FORBIDDEN_PATTERNS = [
  /(^|\s)rm(\s|$)/,
  /(^|\s)sudo(\s|$)/,
  /git\s+reset\s+--hard/,
  /shutdown(\s|$)/,
  /reboot(\s|$)/,
  /diskutil\s+erase/i,
  /mkfs/i,
];

function validateCommand(command: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`命令被策略阻止：${command}`);
    }
  }
}

function truncateOutput(output: string, maxChars = 8000): string {
  if (output.length <= maxChars) return output || "(no output)";
  return `${output.slice(0, maxChars)}\n\n...(输出已截断)`;
}

export function createBashTool(config: AppConfig): AgentTool<typeof bashParameters> {
  return {
    name: "bash",
    label: "bash",
    description: "执行通用 bash 命令。NOTES_ROOT 和 PROJECT_ROOT 仅作为参考环境变量，不限制访问路径。",
    parameters: bashParameters,
    execute: async (_toolCallId, params, signal) => {
      validateCommand(params.command);

      const timeoutMs = Math.max(1, params.timeoutSeconds ?? 60) * 1000;
      const cwd = existsSync(config.projectRoot) ? config.projectRoot : process.cwd();
      const child = spawn("bash", ["-lc", params.command], {
        cwd,
        signal,
        env: {
          ...process.env,
          NOTES_ROOT: config.notesRoot,
          PROJECT_ROOT: config.projectRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`命令超时（>${timeoutMs}ms）`));
        }, timeoutMs);

        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code ?? 0);
        });
      });

      const merged = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const output = truncateOutput(merged);

      if (exitCode !== 0) {
        throw new Error(`${output}\n\n命令退出码：${exitCode}`.trim());
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          command: params.command,
          cwd,
          notesRoot: config.notesRoot,
        },
      };
    },
  };
}
