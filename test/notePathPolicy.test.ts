import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInside, resolveNotePath } from "../src/tools/notePathPolicy.js";

describe("notePathPolicy", () => {
  it("resolves relative Markdown paths inside NOTES_ROOT", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-first-notes-"));
    assert.equal(resolveNotePath(root, "vocab.md"), resolve(root, "vocab.md"));
    assert.equal(resolveNotePath(root, "sessions/today.markdown"), resolve(root, "sessions/today.markdown"));
  });

  it("rejects traversal and absolute paths outside NOTES_ROOT", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-first-notes-"));
    assert.throws(() => resolveNotePath(root, "../secret.md"), /超出允许目录/);
    assert.throws(() => resolveNotePath(root, "/tmp/secret.md"), /超出允许目录/);
  });

  it("rejects non-Markdown files", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-first-notes-"));
    assert.throws(() => resolveNotePath(root, "vocab.txt"), /Markdown/);
  });

  it("detects path containment safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-first-notes-"));
    assert.equal(isPathInside(root, join(root, "a/b.md")), true);
    assert.equal(isPathInside(root, resolve(root, "../outside.md")), false);
  });
});
