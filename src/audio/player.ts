import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";

export class AudioPlayer {
  constructor(private readonly config: AppConfig) {}

  async play(filePath: string): Promise<void> {
    const child = spawn(this.config.audioPlayer, [filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode ?? 0));
    });

    if (code !== 0) {
      throw new Error(`音频播放失败：${stderr || `退出码 ${code}`}`);
    }
  }
}
