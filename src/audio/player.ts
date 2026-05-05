import { spawn, type ChildProcess } from "node:child_process";
import type { AppConfig } from "../config.js";

export class AudioPlayer {
  private current?: ChildProcess;

  constructor(private readonly config: AppConfig) {}

  async play(filePath: string, signal?: AbortSignal): Promise<void> {
    const child = spawn(this.config.audioPlayer, [filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.current = child;

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const abortHandler = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode) => resolve(exitCode ?? 0));
      });

      if (signal?.aborted) {
        throw new Error("音频播放已取消");
      }

      if (code !== 0) {
        throw new Error(`音频播放失败：${stderr || `退出码 ${code}`}`);
      }
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      if (this.current === child) this.current = undefined;
    }
  }

  stop(): void {
    this.current?.kill("SIGTERM");
    this.current = undefined;
  }
}
