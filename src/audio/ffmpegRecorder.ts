import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AppConfig } from "../config.js";

export class FfmpegRecorder {
  private process?: ChildProcessByStdio<null, Readable, Readable>;
  private outputPath?: string;
  private stderr = "";

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("录音已经开始");
    }

    this.stderr = "";
    this.outputPath = join(tmpdir(), `voice-first-recording-${Date.now()}.wav`);
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      this.config.audioInputDevice,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-y",
      this.outputPath,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = proc;

    proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off("error", onError);
        proc.off("close", onClose);
        callback();
      };
      const onError = (error: Error): void => {
        this.process = undefined;
        this.outputPath = undefined;
        settle(() => reject(error));
      };
      const onClose = (code: number | null): void => {
        const message = this.stderr || `ffmpeg 退出码 ${code ?? 0}`;
        this.process = undefined;
        this.outputPath = undefined;
        settle(() => reject(new Error(`录音启动失败：${message}`)));
      };
      const timer = setTimeout(() => settle(resolve), 300);
      proc.once("error", onError);
      proc.once("close", onClose);
    });
  }

  async stop(timeoutMs = 5000): Promise<string> {
    const proc = this.process;
    const outputPath = this.outputPath;
    if (!proc || !outputPath) {
      throw new Error("录音尚未开始");
    }

    await this.stopProcess(proc, "SIGINT", timeoutMs);

    this.process = undefined;
    this.outputPath = undefined;

    if (!existsSync(outputPath)) {
      throw new Error(`录音文件未生成。ffmpeg 输出：${this.stderr || "(empty)"}`);
    }

    const stat = statSync(outputPath);
    if (stat.size === 0) {
      throw new Error(`录音文件为空。ffmpeg 输出：${this.stderr || "(empty)"}`);
    }

    return outputPath;
  }

  async cleanup(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    await this.stopProcess(proc, "SIGTERM", 2000).catch(() => {
      proc.kill("SIGKILL");
    });
    this.process = undefined;
    this.outputPath = undefined;
  }

  private async stopProcess(
    proc: ChildProcessByStdio<null, Readable, Readable>,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off("error", onError);
        proc.off("close", onClose);
        callback();
      };
      const onError = (error: Error): void => settle(() => reject(error));
      const onClose = (): void => settle(resolve);
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        settle(() => reject(new Error(`停止录音超时（>${timeoutMs}ms）`)));
      }, timeoutMs);
      proc.once("error", onError);
      proc.once("close", onClose);
      proc.kill(signal);
    });
  }
}
