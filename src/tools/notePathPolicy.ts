import { extname, isAbsolute, relative, resolve } from "node:path";

const ALLOWED_NOTE_EXTENSIONS = new Set([".md", ".markdown"]);

export function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function resolveNotePath(notesRoot: string, inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new Error("笔记路径不能为空");
  }

  const root = resolve(notesRoot);
  const target = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(root, trimmedPath);

  if (!isPathInside(root, target)) {
    throw new Error(`笔记路径超出允许目录：${inputPath}`);
  }

  const extension = extname(target).toLowerCase();
  if (!ALLOWED_NOTE_EXTENSIONS.has(extension)) {
    throw new Error(`只允许读写 Markdown 笔记文件：${inputPath}`);
  }

  return target;
}
