import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  crsApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiReasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
  elevenlabsApiKey: string;
  elevenlabsVoiceId: string;
  elevenlabsSttModel: string;
  elevenlabsSttLanguageCode?: string;
  elevenlabsTtsModel: string;
  elevenlabsTtsOutputFormat: string;
  notesRoot: string;
  projectRoot: string;
  audioInputDevice: string;
  audioPlayer: string;
  keepTempAudio: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少必填环境变量：${name}`);
  }
  return value;
}

function readReasoning(): AppConfig["openaiReasoning"] {
  const value = (process.env.OPENAI_MODEL_REASONING || "high").trim() as AppConfig["openaiReasoning"];
  const allowed = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  if (!allowed.has(value)) {
    throw new Error(`OPENAI_MODEL_REASONING 不合法：${value}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const notesRoot = resolve(process.env.NOTES_ROOT || "/Users/lettery/Documents/zzm/note/English");
  const projectRoot = resolve(process.env.PROJECT_ROOT || process.cwd());

  return {
    crsApiKey: requireEnv("CRS_OAI_KEY"),
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.gptclubapi.xyz/openai").trim(),
    openaiModel: (process.env.OPENAI_MODEL || "gpt-5.4").trim(),
    openaiReasoning: readReasoning(),
    elevenlabsApiKey: requireEnv("ELEVENLABS_API_KEY"),
    elevenlabsVoiceId: requireEnv("ELEVENLABS_VOICE_ID"),
    elevenlabsSttModel: (process.env.ELEVENLABS_STT_MODEL || "scribe_v2").trim(),
    elevenlabsSttLanguageCode: process.env.ELEVENLABS_STT_LANGUAGE_CODE?.trim() || undefined,
    elevenlabsTtsModel: (process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5").trim(),
    elevenlabsTtsOutputFormat: (process.env.ELEVENLABS_TTS_OUTPUT_FORMAT || "mp3_44100_128").trim(),
    notesRoot,
    projectRoot,
    audioInputDevice: (process.env.AUDIO_INPUT_DEVICE || ":0").trim(),
    audioPlayer: (process.env.AUDIO_PLAYER || "afplay").trim(),
    keepTempAudio: (process.env.KEEP_TEMP_AUDIO || "false").trim().toLowerCase() === "true",
  };
}
