const test = require("node:test");
const assert = require("node:assert/strict");

const helperModule = import("../../src/helpers/markdownToPlainText.ts");

// Every case pins one rule from the spec's table. The first test is the one
// that matters most: it is exactly what the search-preview helper in
// CommandSearch.tsx would fail, because it collapses newlines into spaces.
test("paragraphs, blank lines and line breaks survive untouched", async () => {
  const { markdownToPlainText } = await helperModule;
  const answer = "First paragraph.\n\nSecond paragraph,\nwrapped onto a second line.";
  assert.equal(markdownToPlainText(answer), answer);
});

test("emphasis markers are removed and the words kept", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("**bold** and *em* and __b__ and _e_ and ~~s~~"),
    "bold and em and b and e and s"
  );
  assert.equal(markdownToPlainText("**x**"), "x");
});

test("headings lose their marks", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("## Title\nBody"), "Title\nBody");
});

test("inline code and fenced blocks keep their content verbatim", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("Run `npm test`.\n```bash\nnpm test\n```\nDone."),
    "Run npm test.\nnpm test\nDone."
  );
  assert.equal(markdownToPlainText("```\n**not bold**\n```"), "**not bold**");
});

test("links keep their text and their url; images keep their alt text", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("see [the docs](https://x.y/d)"),
    "see the docs (https://x.y/d)"
  );
  assert.equal(markdownToPlainText("[https://x.y](https://x.y)"), "https://x.y");
  assert.equal(markdownToPlainText("![a chart](chart.png)"), "a chart");
});

test("star and plus bullets become dashes; dashes and numbers stay as typed", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("* one\n+ two\n- three\n1. four"),
    "- one\n- two\n- three\n1. four"
  );
});

test("blockquote markers are removed at line start only", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("> quoted\n>> nested\nx > y"), "quoted\nnested\nx > y");
});

test("horizontal rules are removed", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("a\n---\nb\n* * *\nc"), "a\nb\nc");
});

test("tables become tab-separated rows without the alignment row", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("| Name | Qty |\n|---|---:|\n| Apples | **3** |"),
    "Name\tQty\nApples\t3"
  );
});

test("markdown escapes resolve to the escaped character", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("\\*literal\\* and 5 \\_ 6"), "*literal* and 5 _ 6");
  assert.equal(markdownToPlainText("\\*\\*kept\\*\\*"), "**kept**");
});

test("plain-text conventions a human would type are never altered", async () => {
  const { markdownToPlainText } = await helperModule;
  const answer = "2 * 3 * 4 = 24\nsnake_case_name stays\na lone * star\n#hashtag\nx > y";
  assert.equal(markdownToPlainText(answer), answer);
});

test("dunder identifiers survive the underscored-bold guard", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("def __init__(self): pass"), "def __init__(self): pass");
  assert.equal(markdownToPlainText("MAX__VALUE stays"), "MAX__VALUE stays");
  assert.equal(markdownToPlainText("__bold__ word"), "bold word");
});

test("inline code content is verbatim, never run through other inline rules", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("use `__init__` here"), "use __init__ here");
  assert.equal(markdownToPlainText("inline `**not bold**` code"), "inline **not bold** code");
  assert.equal(markdownToPlainText("`C:\\Users\\me`"), "C:\\Users\\me");
});
