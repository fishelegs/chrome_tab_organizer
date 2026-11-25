const TabImportParser = {
  parse(text) {
    return parseImportText(text);
  },

  getFormatLabel(format) {
    if (format === "yaml") {
      return "YAML";
    }
    if (format === "markdown") {
      return "Markdown";
    }
    if (format === "txt") {
      return "TXT";
    }
    return "未识别";
  }
};

const MARKDOWN_LINK_PATTERN = /^\s*(?:[-*+]\s+)?\[((?:\\.|[^\]])+)\]\((.+)\)\s*$/;
const BLOCKED_PROTOCOLS = new Set(["javascript:", "data:", "vbscript:"]);

function parseImportText(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  if (!text.trim()) {
    return { format: "unknown", tabs: [], errors: [] };
  }

  const format = detectImportFormat(text);
  if (format === "yaml") {
    return parseYaml(text);
  }
  if (format === "markdown") {
    return parseMarkdown(text);
  }
  if (format === "txt") {
    return parseText(text);
  }
  return {
    format: "unknown",
    tabs: [],
    errors: [{ line: null, message: "无法识别格式，请粘贴插件导出的 YAML、Markdown 或 TXT 内容" }]
  };
}

function detectImportFormat(text) {
  if (/^\s*tabs\s*:/m.test(text) || /^\s*-\s*title\s*:/m.test(text)) {
    return "yaml";
  }
  if (text.split(/\r?\n/).some((line) => MARKDOWN_LINK_PATTERN.test(line))) {
    return "markdown";
  }
  if (text.split(/\r?\n/).some((line) => isUrlCandidate(line.trim()))) {
    return "txt";
  }
  return "unknown";
}

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const tabs = [];
  const errors = [];
  let current = null;
  let sawTabsRoot = false;
  let sawItem = false;

  const flush = (lineNumber) => {
    if (!current) {
      return;
    }
    if (!current.hasUrl) {
      errors.push({ line: current.line, message: "缺少 url 字段" });
    } else {
      appendRecord(tabs, errors, current.title, current.url, current.line);
    }
    current = null;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/^\s*tabs\s*:\s*(?:#.*)?$/.test(line)) {
      sawTabsRoot = true;
      return;
    }

    const itemMatch = line.match(/^\s*-\s*title\s*:\s*(.*)$/);
    if (itemMatch) {
      flush(lineNumber);
      current = {
        line: lineNumber,
        title: decodeYamlScalar(itemMatch[1], lineNumber, errors),
        url: "",
        hasUrl: false
      };
      sawItem = true;
      return;
    }

    if (!current || !line.trim()) {
      return;
    }

    const urlMatch = line.match(/^\s+url\s*:\s*(.*)$/);
    if (urlMatch) {
      current.url = decodeYamlScalar(urlMatch[1], lineNumber, errors);
      current.hasUrl = true;
      return;
    }

    if (/^\s*-\s+/.test(line) || /^\s*[A-Za-z_][\w-]*\s*:/.test(line)) {
      flush(lineNumber);
      errors.push({ line: lineNumber, message: "无法识别 YAML 字段" });
    }
  });

  flush(lines.length);
  if (!sawTabsRoot && !sawItem) {
    errors.push({ line: null, message: "YAML 中没有找到 tabs 列表" });
  }
  return { format: "yaml", tabs, errors };
}

function parseMarkdown(text) {
  const tabs = [];
  const errors = [];
  let foundLink = false;

  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const match = line.match(MARKDOWN_LINK_PATTERN);
    if (!match) {
      errors.push({ line: index + 1, message: "无法识别 Markdown 链接" });
      return;
    }
    foundLink = true;
    const title = unescapeMarkdown(match[1]);
    let url = unescapeMarkdown(match[2].trim());
    if (url.startsWith("<") && url.endsWith(">")) {
      url = url.slice(1, -1);
    }
    appendRecord(tabs, errors, title, url, index + 1);
  });

  if (!foundLink) {
    errors.push({ line: null, message: "没有找到可恢复的 Markdown 链接" });
  }
  return { format: "markdown", tabs, errors };
}

function parseText(text) {
  const tabs = [];
  const errors = [];
  const lines = text
    .split(/\r?\n/)
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter((item) => item.value);

  for (let index = 0; index < lines.length;) {
    const titleLine = lines[index];
    if (isUrlCandidate(titleLine.value)) {
      appendRecord(tabs, errors, "", titleLine.value, titleLine.line);
      index += 1;
      continue;
    }

    const urlLine = lines[index + 1];
    if (!urlLine) {
      errors.push({ line: titleLine.line, message: "标题后缺少 URL" });
      break;
    }
    appendRecord(tabs, errors, titleLine.value, urlLine.value, titleLine.line);
    index += 2;
  }

  return { format: "txt", tabs, errors };
}

function appendRecord(tabs, errors, title, url, line) {
  const normalizedUrl = String(url ?? "").trim();
  const urlError = validateUrl(normalizedUrl);
  if (urlError) {
    errors.push({ line, message: urlError });
    return;
  }
  tabs.push({
    title: normalizeTitle(title),
    url: normalizedUrl
  });
}

function decodeYamlScalar(rawValue, line, errors) {
  const value = String(rawValue ?? "").trim();
  if (value.startsWith("\"") || value.startsWith("'")) {
    if (value.startsWith("\"")) {
      try {
        return String(JSON.parse(value));
      } catch (error) {
        errors.push({ line, message: "YAML 字符串引号不完整" });
        return "";
      }
    }
    if (value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    errors.push({ line, message: "YAML 字符串引号不完整" });
    return "";
  }
  return value;
}

function unescapeMarkdown(value) {
  return String(value ?? "").replace(/\\([\\\[\]\(\)])/g, "$1");
}

function normalizeTitle(value) {
  return String(value ?? "").replace(/\r\n?|\n/g, " ").trim();
}

function isUrlCandidate(value) {
  return /^\w[\w+.-]*:\/\//i.test(String(value ?? "").trim()) || /^about:/i.test(String(value ?? "").trim());
}

function validateUrl(value) {
  if (!value) {
    return "URL 不能为空";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return "URL 格式无效";
  }
  if (!parsed.protocol || BLOCKED_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    return "URL 协议不允许恢复";
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TabImportParser;
}
