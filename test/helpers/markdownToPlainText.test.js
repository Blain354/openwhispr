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

test("a literal placeholder sequence in the input survives the restore step", async () => {
  const { markdownToPlainText } = await helperModule;
  // The private-use placeholders are an internal device; text that happens to
  // contain the same sequence indexes no captured span and must come back as
  // it arrived rather than as "undefined".
  const answer = "text with \u{E000}0\u{E001} literal";
  assert.equal(markdownToPlainText(answer), answer);
  assert.equal(markdownToPlainText(`${answer} and \`__init__\``), `${answer} and __init__`);
});

test("URLs keep their literal destinations while surrounding emphasis is removed", async () => {
  const { markdownToPlainText } = await helperModule;
  const url = "https://github.com/acme/service/blob/main/pkg/__init__.py";
  assert.equal(markdownToPlainText(`Open ${url}`), `Open ${url}`);
  assert.equal(markdownToPlainText(`[**Source**](${url})`), `Source (${url})`);
  assert.equal(markdownToPlainText(`[${url}](${url})`), url);
  assert.equal(markdownToPlainText(`**${url}**`), url);
  assert.equal(markdownToPlainText(`_${url}_.`), `${url}.`);
  assert.equal(markdownToPlainText("[module](../pkg/__init__.py)"), "module (../pkg/__init__.py)");
});

test("plain Windows paths survive alongside ordinary markdown and escapes", async () => {
  const { markdownToPlainText } = await helperModule;
  for (const path of [
    String.raw`\\fileserver\finance\budget.xlsx`,
    String.raw`C:\_archive\report.txt`,
  ]) {
    assert.equal(markdownToPlainText(`Open ${path}.`), `Open ${path}.`);
    assert.equal(markdownToPlainText(`**${path}** and **read** it.`), `${path} and read it.`);
    assert.equal(markdownToPlainText(`_${path}_`), path);
  }
  assert.equal(markdownToPlainText(String.raw`\*literal\*`), "*literal*");
});

test("emphasis can enclose prose and literal resources together", async () => {
  const { markdownToPlainText } = await helperModule;
  for (const resource of ["https://example.com/__init__.py", String.raw`C:\_archive\report.txt`]) {
    for (const marker of ["**", "*", "__", "_", "~~"]) {
      assert.equal(markdownToPlainText(`${marker}Open ${resource}${marker}`), `Open ${resource}`);
      assert.equal(markdownToPlainText(`(${marker}${resource}${marker}).`), `(${resource}).`);
    }
  }
  const plain = "snake_case https://example.com/trailing_";
  assert.equal(markdownToPlainText(plain), plain);
  assert.equal(
    markdownToPlainText("https://example.com/trailing_ then _https://example.com/__init__.py_"),
    "https://example.com/trailing_ then https://example.com/__init__.py"
  );
});

test("Windows directories with spaces and quoted filenames remain literal", async () => {
  const { markdownToPlainText } = await helperModule;
  for (const path of [
    String.raw`C:\My Documents\_archive\report.txt`,
    String.raw`\\fileserver\Shared Documents\_archive\report.txt`,
  ]) {
    assert.equal(markdownToPlainText(`Open ${path} and **read** it.`), `Open ${path} and read it.`);
  }
  const quoted = String.raw`"C:\My Documents\report _draft_.txt"`;
  assert.equal(
    markdownToPlainText(`Open ${quoted} and **read** it.`),
    `Open ${quoted} and read it.`
  );
  assert.equal(
    markdownToPlainText(String.raw`C:\report.txt and __read__ \*literal\*`),
    String.raw`C:\report.txt and read *literal*`
  );
  assert.equal(
    markdownToPlainText(String.raw`C:\report.txt and __read__ \_literal\_`),
    String.raw`C:\report.txt and read _literal_`
  );
});

test("only a matching closing fence ends literal code", async () => {
  const { markdownToPlainText } = await helperModule;
  for (const opening of ["````markdown", "~~~~markdown"]) {
    const marker = opening[0];
    const body = ["```js", 'const label = "**draft**";', "```", "~~~", `${marker.repeat(4)} text`];
    const answer = ["Example:", opening, ...body, marker.repeat(5), "**Done.**"].join("\n");
    assert.equal(markdownToPlainText(answer), ["Example:", ...body, "Done."].join("\n"));
  }
});

test("escaped table pipes remain inside their cell and preserve empty cells", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("| Choice | Meaning |\n| --- | --- |\n| A \\| B | either choice |"),
    "Choice\tMeaning\nA | B\teither choice"
  );
  assert.equal(markdownToPlainText(String.raw`| A\\| B |`), "A\\\tB");
  assert.equal(markdownToPlainText(String.raw`| A\\\|B | C |`), "A\\|B\tC");
  assert.equal(markdownToPlainText("| A | | C |"), "A\t\tC");
});
