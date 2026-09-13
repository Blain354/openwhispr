// Turns a model answer into text that is safe to paste into a plain-text
// field. Every line break is preserved: paragraphs, blank lines and list
// lines survive. This is deliberately NOT stripMarkdownPreview from
// CommandSearch.tsx — that helper collapses newlines into spaces to feed
// one-line search previews and would flatten a multi-paragraph answer.
//
// The rules only touch syntax a human would not type in plain text. A `- `
// bullet, a `1.` number, `2 * 3`, snake_case, `#hashtag` and `x > y` are all
// left exactly as written.

const FENCE_LINE = /^\s*(`{3,}|~{3,}).*$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_ALIGNMENT_CELL = /^:?-+:?$/;

function stripInline(text: string): string {
  return (
    text
      .replace(/(?<!\\)`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, url: string) =>
        label === url ? url : `${label} (${url})`
      )
      .replace(/(?<!\\)(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/(?<!\\)~~(\S(?:.*?\S)?)~~/g, "$1")
      // Markers must hug non-space on the inside, not sit inside a word on the
      // outside, and not be escaped — so `2 * 3`, snake_case and `\*` survive.
      .replace(/(?<![\w*\\])\*(\S(?:.*?\S)?)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w_\\])_(\S(?:.*?\S)?)_(?![\w_])/g, "$1")
      // Escapes resolve last so an escaped marker is never re-stripped.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
  );
}

export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) continue;

    if (TABLE_ROW.test(line)) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.every((cell) => TABLE_ALIGNMENT_CELL.test(cell))) continue;
      lines.push(cells.map(stripInline).join("\t"));
      continue;
    }

    const block = line
      .replace(/^(\s{0,3}>\s?)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^(\s*)[*+]\s+/, "$1- ");
    lines.push(stripInline(block));
  }

  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
