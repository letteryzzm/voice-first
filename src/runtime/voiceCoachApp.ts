import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { unlink } from "node:fs/promises";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AppConfig } from "../config.js";
import type { VoiceCoachPorts } from "./ports.js";

type AppState =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "executing bash"
  | "speaking"
  | "done"
  | "error";

export interface VoiceCoachAppOptions {
  onStateChange?: (state: AppState) => void;
  onLine?: (line: string) => void;
  suppressConsole?: boolean;
}

export class VoiceCoachApp {
  private rl?: readline.Interface;
  private state: AppState = "idle";

  constructor(
    private readonly config: AppConfig,
    private readonly ports: VoiceCoachPorts,
    private readonly options: VoiceCoachAppOptions = {},
  ) {
    this.ports.coach.subscribe((event) => {
      this.handleAgentEvent(event);
    });
  }

  async run(): Promise<void> {
    this.rl = readline.createInterface({ input, output });
    this.printBanner();

    try {
      while (true) {
        const answer = (await this.rl.question("\n输入命令（r 开始录音 / s 结束录音 / q 退出）：")).trim();
        const shouldContinue = await this.handleCommand(answer);
        if (!shouldContinue) break;
      }
    } finally {
      await this.cleanup();
      this.rl.close();
      this.rl = undefined;
    }
  }

  async handleCommand(command: string): Promise<boolean> {
    if (command === "q") return false;
    if (command === "r") {
      await this.startRecording();
      return true;
    }
    if (command === "s") {
      await this.stopRecordingAndProcess();
      return true;
    }

    this.writeLine("未知命令，请输入 r、s 或 q。");
    return true;
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled([
      this.ports.recorder.cleanup?.(),
      this.ports.audioOutput.stop?.(),
    ]);
  }

  private printBanner(): void {
    this.writeLine("\nPi 英语语音教练 V1");
    this.writeLine(`- 笔记目录: ${this.config.notesRoot}`);
    this.writeLine(`- 项目目录: ${this.config.projectRoot}`);
    this.writeLine("- 流程: 手动录音 -> STT -> Pi Agent -> TTS -> 播放");
    this.writeLine("- 录音设备可通过 npm run list-audio-devices 检查\n");
  }

  private setState(state: AppState): void {
    this.state = state;
    this.options.onStateChange?.(state);
    this.writeLine(`\n[state] ${state}`);
  }

  private writeLine(line: string): void {
    this.options.onLine?.(line);
    if (!this.options.suppressConsole) console.log(line);
  }

  private async startRecording(): Promise<void> {
    if (this.state === "recording") {
      this.writeLine("当前已经在录音中。请输入 s 结束录音。");
      return;
    }
    await this.ports.recorder.start();
    this.setState("recording");
    this.writeLine("开始录音。说完后输入 s 并回车。\n");
  }

  private async stopRecordingAndProcess(): Promise<void> {
    if (this.state !== "recording") {
      this.writeLine("当前不在录音状态。请先输入 r 开始录音。");
      return;
    }

    let audioPath: string | undefined;
    let audioReplyPath: string | undefined;

    try {
      audioPath = await this.ports.recorder.stop();
      this.setState("transcribing");
      const transcript = await this.ports.speechToText.transcribe(audioPath);
      this.writeLine(`\n[你] ${transcript}`);

      this.setState("thinking");
      const reply = await this.ports.coach.runTurn(transcript);
      this.writeLine(`\n[教练] ${reply}`);

      this.setState("speaking");
      audioReplyPath = await this.ports.textToSpeech.synthesize(reply);
      await this.ports.audioOutput.play(audioReplyPath);

      this.setState("done");
      this.setState("idle");
    } catch (error) {
      this.setState("error");
      console.error(error instanceof Error ? error.message : String(error));
      this.setState("idle");
    } finally {
      await this.removeTempAudio(audioPath);
      await this.removeTempAudio(audioReplyPath);
    }
  }

  private async removeTempAudio(filePath: string | undefined): Promise<void> {
    if (!filePath || this.config.keepTempAudio) return;
    try {
      await unlink(filePath);
    } catch {
      // Best-effort cleanup only; the main turn result should not fail because of temp deletion.
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.setState("executing bash");
      this.writeLine(`\n[tool:start] ${event.toolName}`);
      return;
    }

    if (event.type === "tool_execution_end") {
      this.writeLine(`[tool:end] ${event.toolName}`);
      this.setState("thinking");
    }
  }
}
