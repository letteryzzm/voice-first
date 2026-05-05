import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import { VoiceCoachApp } from "../src/runtime/voiceCoachApp.js";
import type { VoiceCoachPorts } from "../src/runtime/ports.js";

async function makeConfig(): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "voice-first-app-"));
  return {
    crsApiKey: "cr_test",
    openaiBaseUrl: "https://example.test/openai",
    openaiModel: "test-model",
    openaiReasoning: "low",
    elevenlabsApiKey: "sk_test",
    elevenlabsVoiceId: "voice",
    elevenlabsSttModel: "scribe_v2",
    elevenlabsTtsModel: "eleven_flash_v2_5",
    elevenlabsTtsOutputFormat: "mp3_44100_128",
    notesRoot: root,
    projectRoot: root,
    audioInputDevice: ":0",
    audioPlayer: "afplay",
    keepTempAudio: true,
  };
}

function makePorts(overrides: Partial<VoiceCoachPorts> = {}): VoiceCoachPorts {
  return {
    recorder: {
      start: async () => undefined,
      stop: async () => "/tmp/voice-first-test-input.wav",
      cleanup: async () => undefined,
    },
    speechToText: {
      transcribe: async () => "hello coach",
    },
    textToSpeech: {
      synthesize: async () => "/tmp/voice-first-test-output.mp3",
    },
    audioOutput: {
      play: async () => undefined,
      stop: async () => undefined,
    },
    coach: {
      subscribe: () => undefined,
      runTurn: async () => "hello learner",
    },
    ...overrides,
  };
}

describe("VoiceCoachApp", () => {
  it("runs a full fake turn without real audio or network services", async () => {
    const states: string[] = [];
    const lines: string[] = [];
    const app = new VoiceCoachApp(await makeConfig(), makePorts(), {
      onStateChange: (state) => states.push(state),
      onLine: (line) => lines.push(line),
      suppressConsole: true,
    });

    assert.equal(await app.handleCommand("r"), true);
    assert.equal(await app.handleCommand("s"), true);

    assert.deepEqual(states, ["recording", "transcribing", "thinking", "speaking", "done", "idle"]);
    assert.ok(lines.some((line) => line.includes("[你] hello coach")));
    assert.ok(lines.some((line) => line.includes("[教练] hello learner")));
  });

  it("returns to idle when STT fails", async () => {
    const states: string[] = [];
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const app = new VoiceCoachApp(await makeConfig(), makePorts({
        speechToText: { transcribe: async () => { throw new Error("stt down"); } },
      }), {
        onStateChange: (state) => states.push(state),
        suppressConsole: true,
      });

      await app.handleCommand("r");
      await app.handleCommand("s");
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(states, ["recording", "transcribing", "error", "idle"]);
  });

  it("keeps text output available when playback fails", async () => {
    const states: string[] = [];
    const lines: string[] = [];
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const app = new VoiceCoachApp(await makeConfig(), makePorts({
        audioOutput: { play: async () => { throw new Error("speaker down"); } },
      }), {
        onStateChange: (state) => states.push(state),
        onLine: (line) => lines.push(line),
        suppressConsole: true,
      });

      await app.handleCommand("r");
      await app.handleCommand("s");
    } finally {
      console.error = originalError;
    }

    assert.ok(lines.some((line) => line.includes("[教练] hello learner")));
    assert.deepEqual(states, ["recording", "transcribing", "thinking", "speaking", "error", "idle"]);
  });

  it("cleanup stops recorder and audio output", async () => {
    let recorderCleaned = false;
    let playerStopped = false;
    const app = new VoiceCoachApp(await makeConfig(), makePorts({
      recorder: {
        start: async () => undefined,
        stop: async () => "/tmp/voice-first-test-input.wav",
        cleanup: async () => { recorderCleaned = true; },
      },
      audioOutput: {
        play: async () => undefined,
        stop: async () => { playerStopped = true; },
      },
    }), { suppressConsole: true });

    await app.cleanup();

    assert.equal(recorderCleaned, true);
    assert.equal(playerStopped, true);
  });
});
