import type { AppConfig } from "../config.js";
import { PiEnglishCoach } from "../agent/piEnglishCoach.js";
import { FfmpegRecorder } from "../audio/ffmpegRecorder.js";
import { AudioPlayer } from "../audio/player.js";
import { ElevenLabsSpeechService } from "../providers/elevenlabs.js";
import { VoiceCoachApp } from "./voiceCoachApp.js";

export function createProductionVoiceCoachApp(config: AppConfig): VoiceCoachApp {
  const speech = new ElevenLabsSpeechService(config);
  return new VoiceCoachApp(config, {
    recorder: new FfmpegRecorder(config),
    speechToText: speech,
    textToSpeech: speech,
    audioOutput: new AudioPlayer(config),
    coach: new PiEnglishCoach(config),
  });
}
