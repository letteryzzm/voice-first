import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AppConfig } from "../config.js";
import { isPathInside, resolveNotePath } from "./notePathPolicy.js";

const searchNotesParameters = Type.Object({
  query: Type.String({ description: "要在英语笔记中搜索的关键词" }),
  maxResults: Type.Optional(Type.Number({ description: "最多返回多少条匹配，默认 20，最大 100" })),
});

const readNoteParameters = Type.Object({
  path: Type.String({ description: "相对 NOTES_ROOT 的 Markdown 笔记路径" }),
  maxChars: Type.Optional(Type.Number({ description: "最多返回多少字符，默认 8000，最大 20000" })),
});

const appendNoteParameters = Type.Object({
  path: Type.String({ description: "相对 NOTES_ROOT 的 Markdown 笔记路径" }),
  content: Type.String({ description: "要追加到笔记末尾的 Markdown 内容" }),
});

const createNoteParameters = Type.Object({
  path: Type.String({ description: "相对 NOTES_ROOT 的新 Markdown 笔记路径" }),
  content: Type.String({ description: "新笔记的 Markdown 内容" }),
});

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value ?? fallback), max));
}

function isMarkdownPath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function* walkMarkdownFiles(root: string, current = root): AsyncGenerator<string> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(current, entry.name);
    if (!isPathInside(root, entryPath)) continue;
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(root, entryPath);
      continue;
    }
    if (entry.isFile() && isMarkdownPath(entryPath)) {
      yield entryPath;
    }
  }
}

function formatToolText(text: string, maxChars = 8000): string {
  if (!text.trim()) return "(no output)";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...(输出已截断)`;
}

export function createNotesTools(config: AppConfig): AgentTool<any>[] {
  const notesRoot = config.notesRoot;

  const searchNotes: AgentTool<typeof searchNotesParameters> = {
    name: "search_notes",
    label: "search notes",
    description: "只在英语笔记目录内搜索 Markdown 文件内容。不会执行 shell，也不会修改文件。",
    parameters: searchNotesParameters,
    execute: async (_toolCallId, params) => {
      const startedAt = Date.now();
      const query = params.query.trim();
      if (!query) throw new Error("搜索关键词不能为空");

      const maxResults = clamp(params.maxResults, 20, 100);
      const matches: string[] = [];
      const loweredQuery = query.toLowerCase();

      for await (const filePath of walkMarkdownFiles(notesRoot)) {
        const content = await readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(loweredQuery)) continue;
          matches.push(`${relative(notesRoot, filePath)}:${index + 1}: ${lines[index]}`);
          if (matches.length >= maxResults) break;
        }
        if (matches.length >= maxResults) break;
      }

      const text = matches.length > 0 ? matches.join("\n") : `未在英语笔记中找到：${query}`;
      return {
        content: [{ type: "text", text: formatToolText(text) }],
        details: {
          operation: "search_notes",
          query,
          matches: matches.length,
          elapsedMs: Date.now() - startedAt,
        },
      };
    },
  };

  const readNote: AgentTool<typeof readNoteParameters> = {
    name: "read_note",
    label: "read note",
    description: "读取英语笔记目录内的单个 Markdown 文件。路径必须位于 NOTES_ROOT 内。",
    parameters: readNoteParameters,
    execute: async (_toolCallId, params) => {
      const startedAt = Date.now();
      const target = resolveNotePath(notesRoot, params.path);
      const maxChars = clamp(params.maxChars, 8000, 20000);
      const content = await readFile(target, "utf8");
      return {
        content: [{ type: "text", text: formatToolText(content, maxChars) }],
        details: {
          operation: "read_note",
          path: relative(notesRoot, target),
          bytes: Buffer.byteLength(content),
          elapsedMs: Date.now() - startedAt,
        },
      };
    },
  };

  const appendNote: AgentTool<typeof appendNoteParameters> = {
    name: "append_note",
    label: "append note",
    description: "向英语笔记目录内的 Markdown 文件追加内容。不会覆盖已有内容。",
    parameters: appendNoteParameters,
    execute: async (_toolCallId, params) => {
      const startedAt = Date.now();
      const target = resolveNotePath(notesRoot, params.path);
      await mkdir(dirname(target), { recursive: true });
      const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
      await appendFile(target, content, "utf8");
      return {
        content: [{ type: "text", text: `已追加到 ${relative(notesRoot, target)}` }],
        details: {
          operation: "append_note",
          path: relative(notesRoot, target),
          bytes: Buffer.byteLength(content),
          elapsedMs: Date.now() - startedAt,
        },
      };
    },
  };

  const createNote: AgentTool<typeof createNoteParameters> = {
    name: "create_note",
    label: "create note",
    description: "在英语笔记目录内创建新的 Markdown 文件。文件已存在时会失败，避免覆盖用户笔记。",
    parameters: createNoteParameters,
    execute: async (_toolCallId, params) => {
      const startedAt = Date.now();
      const target = resolveNotePath(notesRoot, params.path);
      if (await pathExists(target)) {
        throw new Error(`笔记已存在，请改用 append_note 追加：${relative(notesRoot, target)}`);
      }
      await mkdir(dirname(target), { recursive: true });
      const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
      await writeFile(target, content, "utf8");
      return {
        content: [{ type: "text", text: `已创建 ${relative(notesRoot, target)}` }],
        details: {
          operation: "create_note",
          path: relative(notesRoot, target),
          bytes: Buffer.byteLength(content),
          elapsedMs: Date.now() - startedAt,
        },
      };
    },
  };

  return [searchNotes, readNote, appendNote, createNote];
}
