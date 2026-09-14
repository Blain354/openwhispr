// Turns a model answer into text that is safe to paste into a plain-text
// field. Every line break is preserved: paragraphs, blank lines and list
// lines survive. This is deliberately NOT stripMarkdownPreview from
// CommandSearch.tsx — that helper collapses newlines into spaces to feed
// one-line search previews and would flatten a multi-paragraph answer.
//
// The rules only touch syntax a human would not type in plain text. A `- `
// bullet, a `1.` number, `2 * 3`, snake_case, `#hashtag` and `x > y` are all
// left exactly as written.
//
// The inline rules are applied per line, so emphasis that spans a line break
// and setext (underlined) headings are out of scope: the prompt suffix that
// asks the model for plain prose is the primary defence, and this helper is
// the floor under a model that drifts back to markdown.

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_ALIGNMENT_CELL = /^:?-+:?$/;

const WEB_URL = /(?:https?|ftp):\/\/[^\s<>"`]+/;
// Spaces belong to a directory only when another path component follows;
// otherwise the match would swallow the prose after an unquoted filename.
const WINDOWS_PATH =
  /(?:[a-z]:\\|\\\\[^\s\\<>:"|?*`]+\\)(?:[^\\\r\n<>:"|?*`]*\\(?=[^\s\\<>:"|?*`]))*[^\s<>:"|?*`]*/;
const LITERAL_RESOURCE = new RegExp(`${WEB_URL.source}|${WINDOWS_PATH.source}`, "gi");

function hasOpenEmphasis(text: string, marker: string): boolean {
  let count = 0;
  for (const match of text.matchAll(/(?<!\\)(\*{1,3}|_{1,3}|~~)/g)) {
    if (match[0] !== marker) continue;
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + marker.length] ?? "";
    if (marker.startsWith("_") && /\w/.test(before) && /\w/.test(after)) continue;
    count += 1;
  }
  return count % 2 === 1;
}

function stripInline(text: string): string {
  // Code, URL destinations and Windows paths are data, even when they contain
  // markdown punctuation. Use a prefix absent from the input to avoid collisions.
  const literals: string[] = [];
  let placeholderPrefix = "";
  while (text.includes(placeholderPrefix)) placeholderPrefix += "";
  const preserve = (content: string): string => {
    literals.push(content);
    return `${placeholderPrefix}${literals.length - 1}`;
  };
  const withPlaceholders = text.replace(/(?<!\\)`([^`]+)`/g, (_match, content: string): string =>
    preserve(content)
  );
  let resourceEnd = 0;
  let resourceContext = "";

  const stripped = withPlaceholders
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_match, label: string, url: string): string =>
        label === url ? preserve(url) : `${label} (${preserve(url)})`
    )
    .replace(
      /(["'])((?:[a-z]:\\|\\\\[^\s\\]+\\)[^\r\n]*?)\1/gi,
      (_match, quote: string, path: string): string => quote + preserve(path) + quote
    )
    .replace(LITERAL_RESOURCE, (resource: string, offset: number, source: string): string => {
      // Earlier resources cannot open emphasis; only the surrounding prose can.
      resourceContext += source.slice(resourceEnd, offset);
      resourceEnd = offset + resource.length;
      // A marked-up word after whitespace belongs to prose, not an unquoted
      // directory. Quoted paths were already protected, including such names.
      const proseStart = resource.search(/\s+(?=(?:__\S.*?__|_\S.*?_|~~\S.*?~~)(?:\s|$))/);
      if (proseStart !== -1) {
        const prose = resource.slice(proseStart);
        resourceContext += prose;
        return preserve(resource.slice(0, proseStart)) + prose;
      }
      const closing = resource.match(/(\*{1,3}|_{1,3}|~~)([.,!?;:)\]]*)$/);
      if (closing && hasOpenEmphasis(resourceContext, closing[1])) {
        resourceContext += closing[0];
        return preserve(resource.slice(0, -closing[0].length)) + closing[0];
      }
      return preserve(resource);
    })
    // `**` may sit intraword (intraword bold is legitimate); `__` requires a
    // non-word close that is also not `(`, so dunder identifiers such as
    // `__init__` (immediately followed by a call's `(`) are never mistaken
    // for emphasis, while `__bold__ word` still strips.
    .replace(/(?<!\\)\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/(?<![\w\\])__(\S(?:.*?\S)?)__(?![\w(])/g, "$1")
    .replace(/(?<!\\)~~(\S(?:.*?\S)?)~~/g, "$1")
    // Markers must hug non-space on the inside, not sit inside a word on the
    // outside, and not be escaped — so `2 * 3`, snake_case and `\*` survive.
    // The single-underscore content also may not start or end with `_` itself,
    // so a dunder like `__init__` is never absorbed as `_` + `_init_` + `_`.
    .replace(/(?<![\w*\\])\*(\S(?:.*?\S)?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_\\])_(?!_)(\S(?:.*?[^\s_])?)_(?![\w_])/g, "$1")
    // Escapes resolve last so an escaped marker is never re-stripped.
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");

  return stripped.replace(
    new RegExp(`${placeholderPrefix}(\\d+)`, "g"),
    (_match: string, index: string): string => literals[Number(index)]
  );
}

function splitTableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let backslashes = 0;
  for (const character of row.trim().slice(1, -1)) {
    if (character === "|" && backslashes % 2 === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  cells.push(cell.trim());
  return cells;
}

export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  let openingFence: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(FENCE_LINE);
    if (openingFence) {
      if (
        fence &&
        fence[1][0] === openingFence[0] &&
        fence[1].length >= openingFence.length &&
        fence[2].trim() === ""
      ) {
        openingFence = null;
      } else {
        lines.push(line);
      }
      continue;
    }
    if (fence) {
      openingFence = fence[1];
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) continue;

    if (TABLE_ROW.test(line)) {
      const cells = splitTableCells(line);
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
