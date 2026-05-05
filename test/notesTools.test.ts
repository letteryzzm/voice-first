import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import { createNotesTools } from "../src/tools/notesTools.js";

async function makeConfig(): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "voice-first-notes-"));
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
    keepTempAudio: false,
  };
}

function toolByName(tools: ReturnType<typeof createNotesTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

describe("notesTools", () => {
  it("creates and reads notes without shell access", async () => {
    const config = await makeConfig();
    const tools = createNotesTools(config);
    const createNote = toolByName(tools, "create_note");
    const readNote = toolByName(tools, "read_note");

    await createNote.execute("call-1", { path: "sessions/today.md", content: "hello note" });
    const result = await readNote.execute("call-2", { path: "sessions/today.md" });

    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.text ?? "", /hello note/);
  });

  it("appends without overwriting existing content", async () => {
    const config = await makeConfig();
    const tools = createNotesTools(config);
    const appendNote = toolByName(tools, "append_note");

    await writeFile(join(config.notesRoot, "vocab.md"), "first\n", "utf8");
    await appendNote.execute("call-1", { path: "vocab.md", content: "second" });

    assert.equal(await readFile(join(config.notesRoot, "vocab.md"), "utf8"), "first\nsecond\n");
  });

  it("refuses to create an existing note", async () => {
    const config = await makeConfig();
    const tools = createNotesTools(config);
    const createNote = toolByName(tools, "create_note");

    await writeFile(join(config.notesRoot, "vocab.md"), "first\n", "utf8");
    await assert.rejects(
      () => createNote.execute("call-1", { path: "vocab.md", content: "replacement" }),
      /已存在/,
    );
  });

  it("searches only Markdown notes under NOTES_ROOT", async () => {
    const config = await makeConfig();
    const tools = createNotesTools(config);
    const searchNotes = toolByName(tools, "search_notes");

    await writeFile(join(config.notesRoot, "vocab.md"), "natural expression\n", "utf8");
    await writeFile(join(config.notesRoot, "ignored.txt"), "natural but not markdown\n", "utf8");

    const result = await searchNotes.execute("call-1", { query: "natural" });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /vocab\.md:1/);
    assert.doesNotMatch(text, /ignored\.txt/);
  });

  it("rejects paths outside NOTES_ROOT", async () => {
    const config = await makeConfig();
    const tools = createNotesTools(config);
    const appendNote = toolByName(tools, "append_note");

    await assert.rejects(
      () => appendNote.execute("call-1", { path: "../outside.md", content: "bad" }),
      /超出允许目录/,
    );
  });
});
