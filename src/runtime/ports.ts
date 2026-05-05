import type { AgentEvent } from "@mariozechner/pi-agent-core";

export interface RecorderPort {
  start(): Promise<void> | void;
  stop(): Promise<string>;
  cleanup?(): Promise<void> | void;
}

export interface SpeechToTextPort {
  transcribe(audioPath: string, signal?: AbortSignal): Promise<string>;
}

export interface TextToSpeechPort {
  synthesize(text: string, signal?: AbortSignal): Promise<string>;
}

export interface AudioOutputPort {
  play(filePath: string, signal?: AbortSignal): Promise<void>;
  stop?(): Promise<void> | void;
}

export interface CoachAgentPort {
  subscribe(logger: (event: AgentEvent) => void): void;
  runTurn(userText: string, signal?: AbortSignal): Promise<string>;
}

export interface VoiceCoachPorts {
  recorder: RecorderPort;
  speechToText: SpeechToTextPort;
  textToSpeech: TextToSpeechPort;
  audioOutput: AudioOutputPort;
  coach: CoachAgentPort;
}
