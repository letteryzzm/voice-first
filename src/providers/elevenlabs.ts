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

export class ElevenLabsSpeechService {
  private readonly client: ElevenLabsClient;

  constructor(private readonly config: AppConfig) {
    this.client = new ElevenLabsClient({ apiKey: config.elevenlabsApiKey });
  }

  async transcribe(audioPath: string): Promise<string> {
    const buffer = await readFile(audioPath);
    const file = new File([buffer], `recording${extname(audioPath) || ".bin"}`, {
      type: guessMimeType(audioPath),
    });
    const result = await this.client.speechToText.convert({
      file,
      modelId: this.config.elevenlabsSttModel as any,
      languageCode: this.config.elevenlabsSttLanguageCode,
    });

    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new Error("ElevenLabs 没有返回可用转写文本");
    }
    return text;
  }

  async synthesize(text: string): Promise<string> {
    const audio = await this.client.textToSpeech.convert(this.config.elevenlabsVoiceId, {
      text,
      modelId: this.config.elevenlabsTtsModel,
      outputFormat: this.config.elevenlabsTtsOutputFormat as any,
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
      chunks.push(chunk);
    }

    const outputPath = join(tmpdir(), `voice-first-${Date.now()}.mp3`);
    await writeFile(outputPath, Buffer.concat(chunks));
    return outputPath;
  }
}
