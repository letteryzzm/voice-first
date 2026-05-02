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

  start(): void {
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
  }

  async stop(): Promise<string> {
    const proc = this.process;
    const outputPath = this.outputPath;
    if (!proc || !outputPath) {
      throw new Error("录音尚未开始");
    }

    await new Promise<void>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", () => resolve());
      proc.kill("SIGINT");
    });

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
}
