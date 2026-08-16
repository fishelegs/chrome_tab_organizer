const assert = require("node:assert/strict");
const formatter = require("../export-format.js");

const tabs = [
  { title: "文档: [初稿]", url: "https://example.com/a_(draft)" },
  { title: "多行\n标题", url: "chrome://settings/" },
  { title: "", url: "" }
];

assert.equal(
  formatter.formatTabs(tabs, "markdown"),
  "- [文档: \\[初稿\\]](https://example.com/a_(draft\\))\n- [多行 标题](chrome://settings/)\n- 未命名标签页 — (无 URL)"
);
assert.equal(
  formatter.formatTabs(tabs, "txt"),
  "文档: [初稿]\nhttps://example.com/a_(draft)\n\n多行 标题\nchrome://settings/\n\n未命名标签页\n(无 URL)"
);
assert.equal(
  formatter.formatTabs([{ title: "标题: \"引用\"", url: "https://example.com/?q=a&x=1" }], "yaml"),
  'tabs:\n  - title: "标题: \\"引用\\""\n    url: "https://example.com/?q=a&x=1"'
);
assert.equal(formatter.formatTabs([], "yaml"), "tabs:");
assert.equal(formatter.getFormatLabel("markdown"), "Markdown");
assert.equal(formatter.getFormatLabel("yaml"), "YAML");
assert.equal(formatter.getFormatLabel("txt"), "TXT");

console.log("export format tests passed");
