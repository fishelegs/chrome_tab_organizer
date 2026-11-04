const assert = require("node:assert/strict");
const formatter = require("../export-format.js");
const parser = require("../import-format.js");

const tabs = [
  { title: "文档: [初稿]", url: "https://example.com/a_(draft)" },
  { title: "设置", url: "chrome://settings/" },
  { title: "重复页面", url: "https://example.com/a_(draft)" }
];

const yamlResult = parser.parse(formatter.formatTabs(tabs, "yaml"));
assert.equal(yamlResult.format, "yaml");
assert.deepEqual(yamlResult.tabs, tabs);
assert.deepEqual(yamlResult.errors, []);

const markdownResult = parser.parse(formatter.formatTabs(tabs, "markdown"));
assert.equal(markdownResult.format, "markdown");
assert.deepEqual(markdownResult.tabs, tabs);
assert.deepEqual(markdownResult.errors, []);

const textResult = parser.parse(formatter.formatTabs(tabs, "txt"));
assert.equal(textResult.format, "txt");
assert.deepEqual(textResult.tabs, tabs);
assert.deepEqual(textResult.errors, []);

const malformedYaml = parser.parse('tabs:\n  - title: "缺少网址"');
assert.equal(malformedYaml.format, "yaml");
assert.equal(malformedYaml.tabs.length, 0);
assert.match(malformedYaml.errors[0].message, /缺少 url/);

const blockedMarkdown = parser.parse("- [危险](javascript:alert(1))");
assert.equal(blockedMarkdown.format, "markdown");
assert.equal(blockedMarkdown.tabs.length, 0);
assert.match(blockedMarkdown.errors[0].message, /协议不允许/);

const singleUrl = parser.parse("https://example.com/only");
assert.deepEqual(singleUrl.tabs, [{ title: "", url: "https://example.com/only" }]);

const unknown = parser.parse("这不是导出内容");
assert.equal(unknown.format, "unknown");
assert.equal(unknown.tabs.length, 0);
assert.ok(unknown.errors.length > 0);

console.log("import format tests passed");
