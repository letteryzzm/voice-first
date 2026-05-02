import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AppConfig } from "../config.js";
import { PiEnglishCoach } from "../agent/piEnglishCoach.js";
import { FfmpegRecorder } from "../audio/ffmpegRecorder.js";
import { AudioPlayer } from "../audio/player.js";
import { ElevenLabsSpeechService } from "../providers/elevenlabs.js";

type AppState =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "executing bash"
  | "speaking"
  | "done"
  | "error";

export class VoiceCoachApp {
  private readonly rl = readline.createInterface({ input, output });
  private readonly recorder: FfmpegRecorder;
  private readonly speech: ElevenLabsSpeechService;
  private readonly player: AudioPlayer;
  private readonly coach: PiEnglishCoach;
  private state: AppState = "idle";

  constructor(private readonly config: AppConfig) {
    this.recorder = new FfmpegRecorder(config);
    this.speech = new ElevenLabsSpeechService(config);
    this.player = new AudioPlayer(config);
    this.coach = new PiEnglishCoach(config);

    this.coach.subscribe((event) => {
      this.handleAgentEvent(event);
    });
  }

  async run(): Promise<void> {
    this.printBanner();

    while (true) {
      const answer = (await this.rl.question("\n输入命令（r 开始录音 / s 结束录音 / q 退出）：")).trim();

      if (answer === "q") break;
      if (answer === "r") {
        await this.startRecording();
        continue;
      }
      if (answer === "s") {
        await this.stopRecordingAndProcess();
        continue;
      }

      console.log("未知命令，请输入 r、s 或 q。");
    }

    this.rl.close();
  }

  private printBanner(): void {
    console.log("\nPi 英语语音教练 V1");
    console.log(`- 笔记目录: ${this.config.notesRoot}`);
    console.log(`- 项目目录: ${this.config.projectRoot}`);
    console.log("- 流程: 手动录音 -> STT -> Pi Agent -> TTS -> 播放");
    console.log("- 录音设备可通过 npm run list-audio-devices 检查\n");
  }

  private setState(state: AppState): void {
    this.state = state;
    console.log(`\n[state] ${state}`);
  }

  private async startRecording(): Promise<void> {
    if (this.state === "recording") {
      console.log("当前已经在录音中。请输入 s 结束录音。");
      return;
    }
    this.recorder.start();
    this.setState("recording");
    console.log("开始录音。说完后输入 s 并回车。\n");
  }

  private async stopRecordingAndProcess(): Promise<void> {
    if (this.state !== "recording") {
      console.log("当前不在录音状态。请先输入 r 开始录音。");
      return;
    }

    try {
      const audioPath = await this.recorder.stop();
      this.setState("transcribing");
      const transcript = await this.speech.transcribe(audioPath);
      console.log(`\n[你] ${transcript}`);

      this.setState("thinking");
      const reply = await this.coach.runTurn(transcript);
      console.log(`\n[教练] ${reply}`);

      this.setState("speaking");
      const audioReplyPath = await this.speech.synthesize(reply);
      await this.player.play(audioReplyPath);

      this.setState("done");
      this.setState("idle");
    } catch (error) {
      this.setState("error");
      console.error(error instanceof Error ? error.message : String(error));
      this.setState("idle");
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.setState("executing bash");
      console.log(`\n[tool:start] ${event.toolName}`);
      return;
    }

    if (event.type === "tool_execution_end") {
      console.log(`[tool:end] ${event.toolName}`);
      this.setState("thinking");
    }
  }
}
