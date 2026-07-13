const GROUP_COLOR_MAP = {
  grey: "#9aa0a6",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#0097a7",
  orange: "#fa7b17"
};

const state = {
  hasGroup: false,
  busy: false,
  archives: []
};

const groupColor = document.getElementById("groupColor");
const groupName = document.getElementById("groupName");
const groupMeta = document.getElementById("groupMeta");
const statusText = document.getElementById("status");
const pinButton = document.getElementById("pinButton");
const copyButton = document.getElementById("copyButton");
const archiveButton = document.getElementById("archiveButton");
const archiveList = document.getElementById("archiveList");
const archiveEmpty = document.getElementById("archiveEmpty");

document.addEventListener("DOMContentLoaded", initPopup);
pinButton.addEventListener("click", () => runAction("pin-current-tab-group", "正在置顶..."));
copyButton.addEventListener("click", () => runAction("duplicate-current-tab-group", "正在复制..."));
archiveButton.addEventListener("click", () => runAction("archive-current-tab-group", "正在存档..."));
archiveList.addEventListener("click", handleArchiveListClick);

async function initPopup() {
  await Promise.all([refreshCurrentGroup(), refreshArchives()]);
}

async function refreshCurrentGroup() {
  setStatus("");

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      renderNoGroup();
      return;
    }

    const [group, tabs] = await Promise.all([
      chrome.tabGroups.get(activeTab.groupId),
      chrome.tabs.query({ groupId: activeTab.groupId })
    ]);

    renderGroup(group, tabs.length);
  } catch (error) {
    renderNoGroup();
    setStatus(getErrorMessage(error), "error");
  }
}

function renderGroup(group, tabCount) {
  state.hasGroup = true;
  groupColor.style.background = GROUP_COLOR_MAP[group.color] || GROUP_COLOR_MAP.grey;
  groupName.textContent = group.title || "未命名标签组";
  groupMeta.textContent = `${tabCount} 个标签页`;
  syncButtons();
}

function renderNoGroup() {
  state.hasGroup = false;
  groupColor.style.background = GROUP_COLOR_MAP.grey;
  groupName.textContent = "当前没有标签组";
  groupMeta.textContent = "请选择分组内的任意标签页";
  syncButtons();
}

async function runAction(type, busyText) {
  if (!state.hasGroup || state.busy) {
    return;
  }

  state.busy = true;
  syncButtons();
  setStatus(busyText);

  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      throw new Error(response?.error || "操作没有完成");
    }

    await refreshCurrentGroup();
    await refreshArchives();
    setStatus(response.message || "完成", "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  } finally {
    state.busy = false;
    syncButtons();
  }
}

function syncButtons() {
  const disabled = !state.hasGroup || state.busy;
  pinButton.disabled = disabled;
  copyButton.disabled = disabled;
  archiveButton.disabled = disabled;
  archiveList.querySelectorAll("button").forEach((button) => {
    button.disabled = state.busy;
  });
}

function setStatus(message, variant = "") {
  statusText.textContent = message;
  statusText.className = variant ? `status ${variant}` : "status";
}

function getErrorMessage(error) {
  return error?.message || String(error);
}

async function refreshArchives() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-archives" });
    if (!response?.ok) {
      throw new Error(response?.error || "无法读取存档");
    }

    state.archives = response.archives || [];
    renderArchives();
  } catch (error) {
    state.archives = [];
    renderArchives();
    setStatus(getErrorMessage(error), "error");
  }
}

function renderArchives() {
  archiveList.textContent = "";
  archiveEmpty.hidden = state.archives.length > 0;

  for (const archive of state.archives) {
    const item = document.createElement("div");
    item.className = "archive-item";

    const color = document.createElement("div");
    color.className = "archive-color";
    color.style.background = GROUP_COLOR_MAP[archive.color] || GROUP_COLOR_MAP.grey;

    const copy = document.createElement("div");
    copy.className = "archive-copy";

    const name = document.createElement("div");
    name.className = "archive-name";
    name.textContent = archive.title || "未命名标签组";

    const meta = document.createElement("div");
    meta.className = "archive-meta";
    meta.textContent = `${archive.tabCount || 0} 个标签页 · ${formatDate(archive.createdAt)}`;

    const actions = document.createElement("div");
    actions.className = "archive-actions";

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.textContent = "恢复";
    restoreButton.dataset.action = "restore";
    restoreButton.dataset.archiveId = archive.id;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
    deleteButton.textContent = "删除";
    deleteButton.dataset.action = "delete";
    deleteButton.dataset.archiveId = archive.id;

    copy.append(name, meta);
    actions.append(restoreButton, deleteButton);
    item.append(color, copy, actions);
    archiveList.append(item);
  }

  syncButtons();
}

async function handleArchiveListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || state.busy) {
    return;
  }

  const archiveId = button.dataset.archiveId;
  const action = button.dataset.action;

  if (action === "restore") {
    await runArchiveAction("restore-archived-tab-group", archiveId, "正在恢复...");
  }

  if (action === "delete") {
    const archive = state.archives.find((item) => item.id === archiveId);
    const title = archive?.title || "未命名标签组";
    if (!window.confirm(`删除存档“${title}”？`)) {
      return;
    }

    await runArchiveAction("delete-archive", archiveId, "正在删除...");
  }
}

async function runArchiveAction(type, archiveId, busyText) {
  state.busy = true;
  syncButtons();
  setStatus(busyText);

  try {
    const response = await chrome.runtime.sendMessage({ type, archiveId });
    if (!response?.ok) {
      throw new Error(response?.error || "操作没有完成");
    }

    await refreshCurrentGroup();
    await refreshArchives();
    setStatus(response.message || "完成", "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  } finally {
    state.busy = false;
    syncButtons();
  }
}

function formatDate(value) {
  if (!value) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
