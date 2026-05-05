import readline from "node:readline";
import { stdin as input, stdout as processOutput } from "node:process";
import type { Writable } from "node:stream";
import { unlink } from "node:fs/promises";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import type { VoiceCoachPorts } from "../runtime/ports.js";
import { PiEnglishCoach } from "../agent/piEnglishCoach.js";
import { FfmpegRecorder } from "../audio/ffmpegRecorder.js";
import { AudioPlayer } from "../audio/player.js";
import { ElevenLabsSpeechService } from "../providers/elevenlabs.js";
import { runPreflight } from "../runtime/preflight.js";

type EngineState = "idle" | "recording" | "thinking" | "speaking" | "error";

type EngineCommand =
  | { type: "send_text"; text: string }
  | { type: "start_recording" }
  | { type: "stop_recording" }
  | { type: "interrupt" }
  | { type: "shutdown" };

type EngineEvent =
  | { type: "ready"; state: EngineState }
  | { type: "state"; state: EngineState }
  | { type: "user_text"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string }
  | { type: "error"; message: string }
  | { type: "done" };

let engineOutput: Writable = processOutput;

export function setEngineOutputForTesting(output: Writable): () => void {
  const previous = engineOutput;
  engineOutput = output;
  return () => {
    engineOutput = previous;
  };
}

function emit(event: EngineEvent): void {
  engineOutput.write(`${JSON.stringify(event)}\n`);
}

function parseCommand(line: string): EngineCommand {
  const parsed: unknown = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("命令必须包含 type 字段");
  }
  const command = parsed as { type: unknown; text?: unknown };
  if (command.type === "send_text") {
    if (typeof command.text !== "string" || !command.text.trim()) {
      throw new Error("send_text.text 不能为空");
    }
    return { type: "send_text", text: command.text };
  }
  if (command.type === "start_recording") return { type: "start_recording" };
  if (command.type === "stop_recording") return { type: "stop_recording" };
  if (command.type === "interrupt") return { type: "interrupt" };
  if (command.type === "shutdown") return { type: "shutdown" };
  throw new Error(`未知命令：${String(command.type)}`);
}

export class DesktopVoiceEngine {
  private state: EngineState = "idle";
  private currentAbort?: AbortController;
  private currentAudioPath?: string;
  private currentReplyAudioPath?: string;
  private generation = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly ports: VoiceCoachPorts,
  ) {
    this.ports.coach.subscribe((event) => this.handleAgentEvent(event));
  }

  async handle(command: EngineCommand): Promise<boolean> {
    try {
      if (command.type === "shutdown") {
        await this.shutdown();
        return false;
      }
      if (command.type === "interrupt") {
        await this.interrupt();
        return true;
      }
      if (command.type === "start_recording") {
        await this.startRecording();
        return true;
      }
      if (command.type === "stop_recording") {
        await this.stopRecordingAndRunTurn();
        return true;
      }
      if (command.type === "send_text") {
        await this.runTextTurn(command.text);
        return true;
      }
    } catch (error) {
      this.setState("error");
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      this.setState("idle");
      await this.cleanupTurnFiles();
    }
    return true;
  }

  async shutdown(): Promise<void> {
    await this.interrupt();
    await Promise.allSettled([
      this.ports.recorder.cleanup?.(),
      this.ports.audioOutput.stop?.(),
    ]);
  }

  private async startRecording(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`当前状态不能开始录音：${this.state}`);
    }
    await this.ports.recorder.start();
    this.setState("recording");
  }

  private async stopRecordingAndRunTurn(): Promise<void> {
    if (this.state !== "recording") {
      throw new Error("当前不在录音状态");
    }
    const audioPath = await this.ports.recorder.stop();
    this.currentAudioPath = audioPath;
    const controller = this.beginTurn();
    this.setState("thinking");
    const transcript = await this.ports.speechToText.transcribe(audioPath, controller.signal);
    emit({ type: "user_text", text: transcript });
    await this.completeTurnFromText(transcript, controller, this.generation);
  }

  private async runTextTurn(text: string): Promise<void> {
    if (this.state !== "idle") {
      await this.interrupt();
    }
    const controller = this.beginTurn();
    emit({ type: "user_text", text });
    this.setState("thinking");
    await this.completeTurnFromText(text, controller, this.generation);
  }

  private async completeTurnFromText(text: string, controller: AbortController, turnGeneration: number): Promise<void> {
    const reply = await this.ports.coach.runTurn(text, controller.signal);
    this.ensureCurrentTurn(turnGeneration, controller);
    emit({ type: "assistant_text", text: reply });

    this.setState("speaking");
    const replyAudioPath = await this.ports.textToSpeech.synthesize(reply, controller.signal);
    this.ensureCurrentTurn(turnGeneration, controller);
    this.currentReplyAudioPath = replyAudioPath;
    await this.ports.audioOutput.play(replyAudioPath, controller.signal);
    this.ensureCurrentTurn(turnGeneration, controller);

    emit({ type: "done" });
    await this.cleanupTurnFiles();
    this.currentAbort = undefined;
    this.setState("idle");
  }

  private beginTurn(): AbortController {
    this.generation += 1;
    const controller = new AbortController();
    this.currentAbort = controller;
    return controller;
  }

  private ensureCurrentTurn(turnGeneration: number, controller: AbortController): void {
    if (controller.signal.aborted || turnGeneration !== this.generation) {
      throw new Error("当前 turn 已被打断");
    }
  }

  private async interrupt(): Promise<void> {
    this.generation += 1;
    this.currentAbort?.abort();
    this.currentAbort = undefined;
    await Promise.allSettled([
      this.ports.recorder.cleanup?.(),
      this.ports.audioOutput.stop?.(),
    ]);
    await this.cleanupTurnFiles();
    this.setState("idle");
  }

  private async cleanupTurnFiles(): Promise<void> {
    const paths = [this.currentAudioPath, this.currentReplyAudioPath];
    this.currentAudioPath = undefined;
    this.currentReplyAudioPath = undefined;
    if (this.config.keepTempAudio) return;
    await Promise.allSettled(paths.filter(Boolean).map((path) => unlink(path as string)));
  }

  private setState(state: EngineState): void {
    this.state = state;
    emit({ type: "state", state });
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      emit({ type: "assistant_delta", delta: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "tool_execution_start") {
      emit({ type: "tool_start", name: event.toolName });
      return;
    }
    if (event.type === "tool_execution_end") {
      emit({ type: "tool_end", name: event.toolName });
    }
  }
}

function createProductionPorts(config: AppConfig): VoiceCoachPorts {
  const speech = new ElevenLabsSpeechService(config);
  const coach = new PiEnglishCoach(config);
  return {
    recorder: new FfmpegRecorder(config),
    speechToText: speech,
    textToSpeech: speech,
    audioOutput: new AudioPlayer(config),
    coach,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  await runPreflight(config);
  const engine = new DesktopVoiceEngine(config, createProductionPorts(config));
  emit({ type: "ready", state: "idle" });

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const command = parseCommand(line);
    if (command.type === "shutdown") {
      await engine.handle(command);
      break;
    }
    if (command.type === "interrupt") {
      await engine.handle(command);
      continue;
    }
    void engine.handle(command);
  }
  await engine.shutdown();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
