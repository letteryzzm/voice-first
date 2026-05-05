import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { AppConfig } from "../config.js";

function guessMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  return "application/octet-stream";
}

function extensionForOutputFormat(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.startsWith("mp3")) return ".mp3";
  if (normalized.startsWith("wav")) return ".wav";
  if (normalized.startsWith("pcm")) return ".pcm";
  if (normalized.startsWith("ulaw")) return ".ulaw";
  return ".bin";
}

export class ElevenLabsSpeechService {
  private readonly client: ElevenLabsClient;

  constructor(private readonly config: AppConfig) {
    this.client = new ElevenLabsClient({ apiKey: config.elevenlabsApiKey });
  }

  async transcribe(audioPath: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error("STT 已取消");
    const buffer = await readFile(audioPath);
    const file = new File([buffer], `recording${extname(audioPath) || ".bin"}`, {
      type: guessMimeType(audioPath),
    });
    const result = await this.client.speechToText.convert({
      file,
      modelId: this.config.elevenlabsSttModel as any,
      languageCode: this.config.elevenlabsSttLanguageCode,
    });

    if (signal?.aborted) throw new Error("STT 已取消");
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new Error("ElevenLabs 没有返回可用转写文本");
    }
    return text;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error("TTS 已取消");
    const audio = await this.client.textToSpeech.convert(this.config.elevenlabsVoiceId, {
      text,
      modelId: this.config.elevenlabsTtsModel,
      outputFormat: this.config.elevenlabsTtsOutputFormat as any,
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
      chunks.push(chunk);
    }

    if (signal?.aborted) throw new Error("TTS 已取消");
    const outputPath = join(tmpdir(), `voice-first-${Date.now()}${extensionForOutputFormat(this.config.elevenlabsTtsOutputFormat)}`);
    await writeFile(outputPath, Buffer.concat(chunks));
    return outputPath;
  }
}
