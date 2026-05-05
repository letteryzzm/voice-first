import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import { DesktopVoiceEngine, setEngineOutputForTesting } from "../src/desktop/engine.js";
import type { VoiceCoachPorts } from "../src/runtime/ports.js";

async function makeConfig(): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "voice-first-desktop-engine-"));
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


function captureEngineOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line) lines.push(line);
      }
      callback();
    },
  });
  const restore = setEngineOutputForTesting(sink);
  return { lines, restore };
}

function makePorts(overrides: Partial<VoiceCoachPorts> = {}): VoiceCoachPorts {
  return {
    recorder: {
      start: async () => undefined,
      stop: async () => "/tmp/voice-first-engine-input.wav",
      cleanup: async () => undefined,
    },
    speechToText: { transcribe: async () => "transcribed text" },
    textToSpeech: { synthesize: async () => "/tmp/voice-first-engine-output.mp3" },
    audioOutput: { play: async () => undefined, stop: async () => undefined },
    coach: { subscribe: () => undefined, runTurn: async (text) => `reply to ${text}` },
    ...overrides,
  };
}

describe("DesktopVoiceEngine", () => {
  it("handles a text turn with fake ports", async () => {
    const capture = captureEngineOutput();
    const engine = new DesktopVoiceEngine(await makeConfig(), makePorts());
    await engine.handle({ type: "send_text", text: "hello" });
    await engine.shutdown();
    capture.restore();
    assert.ok(capture.lines.some((line) => line.includes("assistant_text")));
  });

  it("handles manual recording start and stop", async () => {
    const capture = captureEngineOutput();
    let started = false;
    let stopped = false;
    const engine = new DesktopVoiceEngine(await makeConfig(), makePorts({
      recorder: {
        start: async () => { started = true; },
        stop: async () => { stopped = true; return "/tmp/voice-first-engine-input.wav"; },
        cleanup: async () => undefined,
      },
    }));

    await engine.handle({ type: "start_recording" });
    await engine.handle({ type: "stop_recording" });
    await engine.shutdown();

    capture.restore();
    assert.equal(started, true);
    capture.restore();
    assert.equal(stopped, true);
  });

  it("interrupt stops current audio output", async () => {
    const capture = captureEngineOutput();
    let stopped = false;
    const engine = new DesktopVoiceEngine(await makeConfig(), makePorts({
      audioOutput: { play: async () => undefined, stop: async () => { stopped = true; } },
    }));

    await engine.handle({ type: "interrupt" });

    capture.restore();
    assert.equal(stopped, true);
  });
});
