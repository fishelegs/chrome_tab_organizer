const TabExportFormatter = {
  formatTabs(tabs, format) {
    const normalizedTabs = Array.isArray(tabs) ? tabs : [];
    if (format === "yaml") {
      return formatYaml(normalizedTabs);
    }
    if (format === "txt") {
      return formatText(normalizedTabs);
    }
    return formatMarkdown(normalizedTabs);
  },

  getFormatLabel(format) {
    if (format === "yaml") {
      return "YAML";
    }
    if (format === "txt") {
      return "TXT";
    }
    return "Markdown";
  }
};

function formatYaml(tabs) {
  const lines = ["tabs:"];
  for (const tab of tabs) {
    lines.push(`  - title: ${quoteYaml(tab?.title || "")}`);
    lines.push(`    url: ${quoteYaml(tab?.url || "")}`);
  }
  return lines.join("\n");
}

function formatText(tabs) {
  return tabs
    .map((tab) => [
      normalizeLine(tab?.title) || "未命名标签页",
      normalizeLine(tab?.url) || "(无 URL)"
    ].join("\n"))
    .join("\n\n");
}

function formatMarkdown(tabs) {
  return tabs
    .map((tab) => {
      const title = escapeMarkdownTitle(normalizeLine(tab?.title) || "未命名标签页");
      const url = escapeMarkdownUrl(normalizeLine(tab?.url));
      return url ? `- [${title}](${url})` : `- ${title} — (无 URL)`;
    })
    .join("\n");
}

function quoteYaml(value) {
  return JSON.stringify(String(value ?? ""));
}

function normalizeLine(value) {
  return String(value ?? "").replace(/\r\n?|\n/g, " ").trim();
}

function escapeMarkdownTitle(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function escapeMarkdownUrl(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\)/g, "\\)");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TabExportFormatter;
}
