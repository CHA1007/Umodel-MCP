import fs from "node:fs";
import path from "node:path";

export interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

interface Node {
  name: string;
  isDir: boolean;
  size: number;
  children: Node[];
}

function buildTree(dir: string, depth: number, maxDepth: number): Node {
  const node: Node = { name: path.basename(dir) || dir, isDir: true, size: 0, children: [] };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const child =
        depth < maxDepth
          ? buildTree(full, depth + 1, maxDepth)
          : { name: e.name, isDir: true, size: 0, children: [] };
      node.size += child.size;
      node.children.push(child);
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      node.size += size;
      node.children.push({ name: e.name, isDir: false, size, children: [] });
    }
  }
  return node;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function render(node: Node, indent: string, lines: string[], budget: { left: number }): void {
  if (budget.left <= 0) {
    lines.push(`${indent}...（已截断）`);
    return;
  }
  for (const c of node.children) {
    if (budget.left <= 0) {
      lines.push(`${indent}...（已截断）`);
      return;
    }
    budget.left--;
    if (c.isDir) {
      lines.push(`${indent}${c.name}/`);
      render(c, indent + "  ", lines, budget);
    } else {
      lines.push(`${indent}${c.name}  (${formatSize(c.size)})`);
    }
  }
}

export function listTree(root: string, opts: TreeOptions = {}): string {
  if (!fs.existsSync(root)) return `Directory does not exist: ${root}`;
  const maxDepth = opts.maxDepth ?? 8;
  const maxEntries = opts.maxEntries ?? 400;
  const tree = buildTree(root, 1, maxDepth);
  const lines: string[] = [`${path.resolve(root)}/  (${formatSize(tree.size)})`];
  render(tree, "  ", lines, { left: maxEntries });
  return lines.join("\n");
}
