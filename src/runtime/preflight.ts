import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);

function isPlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes("your_") || lowered.includes("placeholder") || lowered.includes("example");
}

async function assertDirectory(path: string, label: string, writable = false): Promise<void> {
  const info = await stat(path).catch(() => {
    throw new Error(`${label} 不存在：${path}`);
  });
  if (!info.isDirectory()) {
    throw new Error(`${label} 不是目录：${path}`);
  }
  await access(path, writable ? constants.R_OK | constants.W_OK : constants.R_OK).catch(() => {
    throw new Error(`${label} 权限不足：${path}`);
  });
}

async function assertCommandAvailable(command: string, label: string): Promise<void> {
  if (isAbsolute(command) || command.includes("/")) {
    await access(command, constants.X_OK).catch(() => {
      throw new Error(`${label} 不可执行：${command}`);
    });
    return;
  }

  await execFileAsync("which", [command]).catch(() => {
    throw new Error(`${label} 未找到：${command}。请安装或在 .env 中配置正确路径。`);
  });
}

export async function runPreflight(config: AppConfig): Promise<void> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor < 20) {
    throw new Error(`Node.js 版本过低：${process.versions.node}。请使用 Node.js 20 或更高版本。`);
  }

  if (isPlaceholder(config.crsApiKey)) {
    throw new Error("CRS_OAI_KEY 仍是示例值，请在 .env 中配置真实密钥。");
  }
  if (isPlaceholder(config.elevenlabsApiKey)) {
    throw new Error("ELEVENLABS_API_KEY 仍是示例值，请在 .env 中配置真实密钥。");
  }

  await assertCommandAvailable("ffmpeg", "ffmpeg");
  await assertCommandAvailable(config.audioPlayer, "音频播放器");
}
