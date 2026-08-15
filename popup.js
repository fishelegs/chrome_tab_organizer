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
  archives: [],
  folders: [],
  storageInfo: null,
  collapsedFolders: new Set()
};

const groupColor = document.getElementById("groupColor");
const groupName = document.getElementById("groupName");
const groupMeta = document.getElementById("groupMeta");
const statusText = document.getElementById("status");
const syncStatus = document.getElementById("syncStatus");
const pinButton = document.getElementById("pinButton");
const copyButton = document.getElementById("copyButton");
const archiveButton = document.getElementById("archiveButton");
const archiveFolderSelect = document.getElementById("archiveFolderSelect");
const createFolderButton = document.getElementById("createFolderButton");
const archiveList = document.getElementById("archiveList");
const archiveEmpty = document.getElementById("archiveEmpty");
let storageRefreshTimer;

document.addEventListener("DOMContentLoaded", initPopup);
pinButton.addEventListener("click", () => runCurrentGroupAction("pin-current-tab-group", "正在置顶..."));
copyButton.addEventListener("click", () => runCurrentGroupAction("duplicate-current-tab-group", "正在复制..."));
archiveButton.addEventListener("click", () => {
  runCurrentGroupAction("archive-current-tab-group", "正在存档...", {
    folderId: archiveFolderSelect.value || null
  });
});
createFolderButton.addEventListener("click", createFolder);
archiveList.addEventListener("click", handleArchiveListClick);
archiveList.addEventListener("change", handleArchiveListChange);

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!state.busy && (areaName === "sync" || areaName === "local")) {
      clearTimeout(storageRefreshTimer);
      storageRefreshTimer = setTimeout(() => refreshArchives({ silent: true }), 120);
    }
  });
}

async function initPopup() {
  await Promise.all([refreshCurrentGroup(), refreshArchives()]);
}

async function refreshCurrentGroup() {
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

async function runCurrentGroupAction(type, busyText, extra = {}) {
  if (!state.hasGroup || state.busy) {
    return;
  }

  await withBusyState(busyText, async () => {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    assertSuccessfulResponse(response);
    await Promise.all([refreshCurrentGroup(), refreshArchives({ silent: true })]);
    setStatus(response.message || "完成", "success");
  });
}

async function refreshArchives(options = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-archive-library" });
    assertSuccessfulResponse(response, "无法读取存档");
    state.archives = response.archives || [];
    state.folders = response.folders || [];
    state.storageInfo = response.storageInfo || null;
    renderArchiveDestination();
    renderArchives();
    renderSyncStatus();
  } catch (error) {
    state.archives = [];
    state.folders = [];
    state.storageInfo = null;
    renderArchiveDestination();
    renderArchives();
    syncStatus.textContent = "同步状态读取失败";
    if (!options.silent) {
      setStatus(getErrorMessage(error), "error");
    }
  }
}

function renderArchiveDestination() {
  const previousValue = archiveFolderSelect.value;
  archiveFolderSelect.textContent = "";
  archiveFolderSelect.append(createOption("", "未分类"));
  for (const folder of state.folders) {
    archiveFolderSelect.append(createOption(folder.id, folder.name));
  }
  archiveFolderSelect.value = state.folders.some((folder) => folder.id === previousValue) ? previousValue : "";
}

function renderArchives() {
  archiveList.textContent = "";
  archiveEmpty.hidden = state.archives.length > 0 || state.folders.length > 0;

  for (const folder of state.folders) {
    const archives = state.archives.filter((archive) => archive.folderId === folder.id);
    archiveList.append(createFolderSection(folder, archives));
  }

  const uncategorized = state.archives.filter((archive) => !archive.folderId);
  if (uncategorized.length > 0) {
    archiveList.append(createFolderSection(null, uncategorized));
  }

  syncButtons();
}

function createFolderSection(folder, archives) {
  const folderId = folder?.id || "";
  const collapseKey = folderId || "__uncategorized__";
  const collapsed = state.collapsedFolders.has(collapseKey);
  const section = document.createElement("section");
  section.className = "archive-folder";

  const header = document.createElement("div");
  header.className = "folder-header";

  const toggleButton = createActionButton(collapsed ? "›" : "⌄", "toggle-folder");
  toggleButton.className = "folder-toggle";
  toggleButton.dataset.folderId = folderId;
  toggleButton.setAttribute("aria-label", collapsed ? "展开文件夹" : "收起文件夹");

  const nameBox = document.createElement("div");
  nameBox.className = "folder-name-box";
  const name = document.createElement("div");
  name.className = "folder-name";
  name.textContent = folder?.name || "未分类";
  const count = document.createElement("div");
  count.className = "folder-count";
  count.textContent = `${archives.length} 个标签组`;
  nameBox.append(name, count);

  const actions = document.createElement("div");
  actions.className = "folder-actions";
  const restoreAll = createActionButton("全部恢复", "restore-folder");
  restoreAll.dataset.folderId = folderId;
  restoreAll.dataset.empty = archives.length === 0 ? "true" : "false";
  restoreAll.disabled = archives.length === 0;
  actions.append(restoreAll);

  if (folder) {
    const rename = createActionButton("改名", "rename-folder");
    rename.dataset.folderId = folder.id;
    const remove = createActionButton("删除", "delete-folder");
    remove.classList.add("danger");
    remove.dataset.folderId = folder.id;
    actions.append(rename, remove);
  }

  header.append(toggleButton, nameBox, actions);
  section.append(header);

  const items = document.createElement("div");
  items.className = "folder-items";
  items.hidden = collapsed;
  for (const archive of archives) {
    items.append(createArchiveItem(archive));
  }
  if (archives.length === 0) {
    const empty = document.createElement("div");
    empty.className = "folder-empty";
    empty.textContent = "可把存档移动到这里";
    items.append(empty);
  }
  section.append(items);
  return section;
}

function createArchiveItem(archive) {
  const item = document.createElement("div");
  item.className = "archive-item";

  const color = document.createElement("div");
  color.className = "archive-color";
  color.style.background = GROUP_COLOR_MAP[archive.color] || GROUP_COLOR_MAP.grey;

  const content = document.createElement("div");
  content.className = "archive-content";

  const heading = document.createElement("div");
  heading.className = "archive-heading";
  const copy = document.createElement("div");
  copy.className = "archive-copy";
  const name = document.createElement("div");
  name.className = "archive-name";
  name.textContent = archive.title || "未命名标签组";
  const meta = document.createElement("div");
  meta.className = "archive-meta";
  meta.textContent = `${archive.tabCount || 0} 个标签页 · ${formatDate(archive.createdAt)}`;
  copy.append(name, meta);

  const location = document.createElement("span");
  location.className = archive.storageArea === "local" ? "storage-pill local" : "storage-pill";
  location.textContent = archive.storageArea === "local" ? "仅本机" : "已同步";
  heading.append(copy, location);

  const actions = document.createElement("div");
  actions.className = "archive-actions";
  const moveSelect = document.createElement("select");
  moveSelect.className = "move-select";
  moveSelect.dataset.action = "move-archive";
  moveSelect.dataset.archiveId = archive.id;
  moveSelect.setAttribute("aria-label", "移动存档到文件夹");
  moveSelect.append(createOption("", "未分类"));
  for (const folder of state.folders) {
    moveSelect.append(createOption(folder.id, folder.name));
  }
  moveSelect.value = archive.folderId || "";

  const restoreButton = createActionButton("恢复", "restore");
  restoreButton.dataset.archiveId = archive.id;
  const deleteButton = createActionButton("删除", "delete");
  deleteButton.classList.add("danger");
  deleteButton.dataset.archiveId = archive.id;

  actions.append(moveSelect, restoreButton, deleteButton);
  content.append(heading, actions);
  item.append(color, content);
  return item;
}

async function handleArchiveListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || state.busy) {
    return;
  }

  const action = button.dataset.action;
  const archiveId = button.dataset.archiveId;
  const folderId = button.dataset.folderId || null;

  if (action === "toggle-folder") {
    const collapseKey = folderId || "__uncategorized__";
    if (state.collapsedFolders.has(collapseKey)) {
      state.collapsedFolders.delete(collapseKey);
    } else {
      state.collapsedFolders.add(collapseKey);
    }
    renderArchives();
    return;
  }

  if (action === "restore") {
    await runLibraryAction({ type: "restore-archived-tab-group", archiveId }, "正在恢复...");
    return;
  }

  if (action === "restore-folder") {
    await runLibraryAction({ type: "restore-folder", folderId }, "正在恢复整个文件夹...");
    return;
  }

  if (action === "delete") {
    const archive = state.archives.find((item) => item.id === archiveId);
    const title = archive?.title || "未命名标签组";
    if (window.confirm(`删除存档“${title}”？`)) {
      await runLibraryAction({ type: "delete-archive", archiveId }, "正在删除...");
    }
    return;
  }

  if (action === "rename-folder") {
    const folder = state.folders.find((item) => item.id === folderId);
    const name = window.prompt("新的文件夹名称", folder?.name || "");
    if (name !== null) {
      await runLibraryAction({ type: "rename-folder", folderId, name }, "正在重命名...");
    }
    return;
  }

  if (action === "delete-folder") {
    const folder = state.folders.find((item) => item.id === folderId);
    if (window.confirm(`删除文件夹“${folder?.name || ""}”？其中的存档会移到“未分类”。`)) {
      await runLibraryAction({ type: "delete-folder", folderId }, "正在删除文件夹...");
    }
  }
}

async function handleArchiveListChange(event) {
  const select = event.target.closest("select[data-action='move-archive']");
  if (!select || state.busy) {
    return;
  }
  await runLibraryAction({
    type: "move-archive",
    archiveId: select.dataset.archiveId,
    folderId: select.value || null
  }, "正在移动...");
}

async function createFolder() {
  if (state.busy) {
    return;
  }
  const name = window.prompt("文件夹名称");
  if (name === null) {
    return;
  }

  await withBusyState("正在创建文件夹...", async () => {
    const response = await chrome.runtime.sendMessage({ type: "create-folder", name });
    assertSuccessfulResponse(response);
    await refreshArchives({ silent: true });
    archiveFolderSelect.value = response.folder?.id || "";
    setStatus(response.message || "已创建文件夹", "success");
  });
}

async function runLibraryAction(message, busyText) {
  await withBusyState(busyText, async () => {
    const response = await chrome.runtime.sendMessage(message);
    assertSuccessfulResponse(response);
    await Promise.all([refreshCurrentGroup(), refreshArchives({ silent: true })]);
    setStatus(response.message || "完成", "success");
  });
}

async function withBusyState(busyText, operation) {
  state.busy = true;
  syncButtons();
  setStatus(busyText);
  try {
    await operation();
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  } finally {
    state.busy = false;
    syncButtons();
  }
}

function syncButtons() {
  const currentGroupDisabled = !state.hasGroup || state.busy;
  pinButton.disabled = currentGroupDisabled;
  copyButton.disabled = currentGroupDisabled;
  archiveButton.disabled = currentGroupDisabled;
  archiveFolderSelect.disabled = state.busy;
  createFolderButton.disabled = state.busy;
  archiveList.querySelectorAll("button, select").forEach((control) => {
    control.disabled = state.busy || (control.dataset.action === "restore-folder" && control.dataset.empty === "true");
  });
}

function renderSyncStatus() {
  if (!state.storageInfo) {
    syncStatus.textContent = "同步状态不可用";
    return;
  }
  const used = formatBytes(state.storageInfo.bytesInUse || 0);
  const quota = formatBytes(state.storageInfo.quotaBytes || 102400);
  const localSuffix = state.storageInfo.localCount > 0 ? ` · ${state.storageInfo.localCount} 条仅本机` : "";
  syncStatus.textContent = `Chrome 同步 ${used} / ${quota}${localSuffix}`;
}

function createActionButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  return button;
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function assertSuccessfulResponse(response, fallback = "操作没有完成") {
  if (!response?.ok) {
    throw new Error(response?.error || fallback);
  }
}

function setStatus(message, variant = "") {
  statusText.textContent = message;
  statusText.className = variant ? `status ${variant}` : "status";
}

function getErrorMessage(error) {
  return error?.message || String(error);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
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
