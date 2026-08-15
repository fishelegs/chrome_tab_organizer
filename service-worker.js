const BADGE_CLEAR_DELAY_MS = 2500;
const LEGACY_ARCHIVES_STORAGE_KEY = "tabGroupArchives";
const LOCAL_ARCHIVES_STORAGE_KEY = "tabGroupArchivesLocalV2";
const MIGRATION_STORAGE_KEY = "tabGroupArchivesMigrationV2";
const SYNC_ARCHIVE_PREFIX = "tga.v2.archive.";
const SYNC_CHUNK_PREFIX = "tga.v2.tabs.";
const SYNC_FOLDER_PREFIX = "tga.v2.folder.";
const ARCHIVE_SCHEMA_VERSION = 2;
const SYNC_SAFE_ITEM_BYTES = 7600;
const SYNC_QUOTA_BYTES = 102400;
const MAX_ARCHIVES = 100;
const MAX_FOLDERS = 30;
const MAX_FOLDER_NAME_LENGTH = 40;

let migrationPromise;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "duplicate-current-tab-group") {
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    return;
  }

  duplicateTabGroup(activeTab).catch((error) => {
    console.error("复制标签组失败", error);
    showBadge("ERR", "#c5221f", activeTab.id);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("标签组操作失败", error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });

  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    throw new Error("未知操作");
  }

  if (message.type === "get-archives" || message.type === "get-archive-library") {
    const library = await getArchiveLibrary();
    return { ok: true, ...library };
  }

  if (message.type === "restore-archived-tab-group") {
    const result = await restoreArchivedTabGroup(message.archiveId);
    return result ? { ok: true, message: "已恢复存档" } : { ok: false, error: "没有找到这条存档" };
  }

  if (message.type === "restore-folder") {
    const result = await restoreFolder(message.folderId ?? null);
    return result
      ? { ok: true, message: `已恢复 ${result.groupCount} 个标签组` }
      : { ok: false, error: "这个文件夹中没有存档" };
  }

  if (message.type === "delete-archive") {
    const result = await deleteArchive(message.archiveId);
    return result ? { ok: true, message: "已删除存档" } : { ok: false, error: "没有找到这条存档" };
  }

  if (message.type === "create-folder") {
    const folder = await createFolder(message.name);
    return { ok: true, folder, message: "已创建文件夹" };
  }

  if (message.type === "rename-folder") {
    const folder = await renameFolder(message.folderId, message.name);
    return folder ? { ok: true, folder, message: "已重命名文件夹" } : { ok: false, error: "没有找到这个文件夹" };
  }

  if (message.type === "delete-folder") {
    const result = await deleteFolder(message.folderId);
    return result ? { ok: true, message: "已删除文件夹，存档已移到未分类" } : { ok: false, error: "没有找到这个文件夹" };
  }

  if (message.type === "move-archive") {
    const archive = await moveArchive(message.archiveId, message.folderId ?? null);
    return archive ? { ok: true, message: "已移动存档" } : { ok: false, error: "没有找到这条存档" };
  }

  const activeTab = await getActiveTab();

  if (message.type === "duplicate-current-tab-group") {
    const result = await duplicateTabGroup(activeTab);
    return result ? { ok: true, message: "已复制标签组" } : { ok: false, error: "当前没有标签组" };
  }

  if (message.type === "pin-current-tab-group") {
    const result = await pinTabGroupToFront(activeTab);
    return result ? { ok: true, message: "已置顶标签组" } : { ok: false, error: "当前没有标签组" };
  }

  if (message.type === "archive-current-tab-group") {
    const result = await archiveCurrentTabGroup(activeTab, message.folderId ?? null);
    if (!result) {
      return { ok: false, error: "当前没有标签组" };
    }
    return {
      ok: true,
      message: result.storageArea === "local" ? "已存档并收起（仅本机）" : "已同步存档并收起"
    };
  }

  throw new Error("未知操作");
}

async function duplicateTabGroup(activeTab) {
  const result = await cloneTabGroup(activeTab, { placement: "after" });
  if (!result) {
    await showBadge("无组", "#5f6368", activeTab?.id);
    return null;
  }

  await showBadge("✓", "#188038", activeTab.id);
  return result;
}

async function pinTabGroupToFront(activeTab) {
  const result = await cloneTabGroup(activeTab, { placement: "front" });
  if (!result) {
    await showBadge("无组", "#5f6368", activeTab?.id);
    return null;
  }

  await chrome.tabs.update(result.activeCreatedTabId, { active: true });
  await chrome.tabs.remove(result.sourceTabIds);
  await showBadge("✓", "#188038", result.activeCreatedTabId);
  return result;
}

async function cloneTabGroup(activeTab, options = {}) {
  if (!activeTab || activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return null;
  }

  const [sourceGroup, sourceTabs] = await Promise.all([
    chrome.tabGroups.get(activeTab.groupId),
    chrome.tabs.query({ groupId: activeTab.groupId })
  ]);

  sourceTabs.sort((left, right) => left.index - right.index);
  if (sourceTabs.length === 0) {
    throw new Error("标签组中没有可复制的标签页");
  }

  const insertionIndex = options.placement === "front" ? 0 : sourceTabs[sourceTabs.length - 1].index + 1;
  const activeSourceIndex = Math.max(0, sourceTabs.findIndex((tab) => tab.id === activeTab.id));
  const createdTabIds = [];

  try {
    for (let offset = 0; offset < sourceTabs.length; offset += 1) {
      const sourceTab = sourceTabs[offset];
      const url = sourceTab.pendingUrl || sourceTab.url;

      if (!url) {
        throw new Error(`无法读取标签页 ${sourceTab.id} 的网址`);
      }

      const createdTab = await chrome.tabs.create({
        windowId: sourceGroup.windowId,
        index: insertionIndex + offset,
        url,
        active: false
      });

      createdTabIds.push(createdTab.id);
    }

    const newGroupId = await chrome.tabs.group({
      tabIds: createdTabIds,
      createProperties: { windowId: sourceGroup.windowId }
    });

    await chrome.tabGroups.update(newGroupId, {
      title: sourceGroup.title || "",
      color: sourceGroup.color,
      collapsed: sourceGroup.collapsed
    });

    return {
      newGroupId,
      createdTabIds,
      sourceTabIds: sourceTabs.map((tab) => tab.id),
      activeCreatedTabId: createdTabIds[activeSourceIndex] || createdTabIds[0]
    };
  } catch (error) {
    if (createdTabIds.length > 0) {
      await chrome.tabs.remove(createdTabIds).catch(() => {});
    }
    throw error;
  }
}

async function archiveCurrentTabGroup(activeTab, folderId = null) {
  const snapshot = await getTabGroupSnapshot(activeTab);
  if (!snapshot) {
    await showBadge("无组", "#5f6368", activeTab?.id);
    return null;
  }

  if (folderId) {
    const folder = await getFolder(folderId);
    if (!folder) {
      throw new Error("选择的文件夹已经不存在");
    }
  }

  const library = await getArchiveLibrary();
  if (library.archives.length >= MAX_ARCHIVES) {
    throw new Error(`最多保存 ${MAX_ARCHIVES} 条存档，请先删除不需要的存档`);
  }

  const now = new Date().toISOString();
  const archive = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    id: createRecordId(),
    folderId,
    title: snapshot.group.title || "",
    color: snapshot.group.color,
    collapsed: snapshot.group.collapsed,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tabCount: snapshot.tabs.length,
    tabs: snapshot.tabs.map((tab) => ({
      title: tab.title || "",
      url: tab.pendingUrl || tab.url
    }))
  };

  const storageArea = await saveNewArchive(archive);
  await chrome.tabs.remove(snapshot.tabs.map((tab) => tab.id));
  await showBadge("存", storageArea === "sync" ? "#188038" : "#e37400");
  return { ...archive, storageArea };
}

async function restoreArchivedTabGroup(archiveId) {
  const archive = await getArchive(archiveId);
  if (!archive) {
    return null;
  }

  const activeTab = await getActiveTab({ required: false });
  const insertionIndex = activeTab ? activeTab.index + 1 : undefined;
  const result = await restoreArchiveRecord(archive, {
    windowId: activeTab?.windowId,
    insertionIndex
  });

  await chrome.tabs.update(result.createdTabIds[0], { active: true });
  await showBadge("✓", "#188038", result.createdTabIds[0]);
  return result;
}

async function restoreFolder(folderId) {
  const library = await getArchiveLibrary();
  const archives = library.archives.filter((archive) => (archive.folderId || null) === (folderId || null));
  if (archives.length === 0) {
    return null;
  }

  const activeTab = await getActiveTab({ required: false });
  let insertionIndex = activeTab ? activeTab.index + 1 : undefined;
  const allCreatedTabIds = [];
  const restoredGroups = [];

  try {
    for (const archiveMetadata of archives) {
      const archive = await getArchive(archiveMetadata.id);
      if (!archive) {
        continue;
      }
      const result = await restoreArchiveRecord(archive, {
        windowId: activeTab?.windowId,
        insertionIndex
      });
      restoredGroups.push(result);
      allCreatedTabIds.push(...result.createdTabIds);
      if (insertionIndex !== undefined) {
        insertionIndex += result.createdTabIds.length;
      }
    }
  } catch (error) {
    if (allCreatedTabIds.length > 0) {
      await chrome.tabs.remove(allCreatedTabIds).catch(() => {});
    }
    throw error;
  }

  if (allCreatedTabIds.length === 0) {
    return null;
  }

  await chrome.tabs.update(allCreatedTabIds[0], { active: true });
  await showBadge("✓", "#188038", allCreatedTabIds[0]);
  return { groupCount: restoredGroups.length, createdTabIds: allCreatedTabIds };
}

async function restoreArchiveRecord(archive, options = {}) {
  if (!Array.isArray(archive.tabs) || archive.tabs.length === 0) {
    throw new Error("这条存档没有可恢复的标签页");
  }

  const createdTabIds = [];
  try {
    for (let offset = 0; offset < archive.tabs.length; offset += 1) {
      const archivedTab = archive.tabs[offset];
      const createProperties = { url: archivedTab.url, active: false };

      if (options.windowId !== undefined) {
        createProperties.windowId = options.windowId;
      }
      if (options.insertionIndex !== undefined) {
        createProperties.index = options.insertionIndex + offset;
      }

      const createdTab = await chrome.tabs.create(createProperties);
      createdTabIds.push(createdTab.id);
    }

    const groupProperties = { tabIds: createdTabIds };
    if (options.windowId !== undefined) {
      groupProperties.createProperties = { windowId: options.windowId };
    }

    const newGroupId = await chrome.tabs.group(groupProperties);
    await chrome.tabGroups.update(newGroupId, {
      title: archive.title || "",
      color: archive.color,
      collapsed: archive.collapsed
    });

    return { newGroupId, createdTabIds };
  } catch (error) {
    if (createdTabIds.length > 0) {
      await chrome.tabs.remove(createdTabIds).catch(() => {});
    }
    throw error;
  }
}

async function deleteArchive(archiveId) {
  await ensureArchiveMigration();
  const syncData = await chrome.storage.sync.get(null);
  const syncRecord = syncData[getArchiveKey(archiveId)];
  if (syncRecord && !syncRecord.deletedAt) {
    const now = new Date().toISOString();
    await chrome.storage.sync.set({
      [getArchiveKey(archiveId)]: {
        ...syncRecord,
        tabCount: 0,
        chunkCount: 0,
        updatedAt: now,
        deletedAt: now
      }
    });
    await removeArchiveChunks(archiveId, syncRecord.chunkCount || 0);
    return true;
  }

  const localArchives = await getLocalArchives();
  const nextArchives = localArchives.filter((archive) => archive.id !== archiveId);
  if (nextArchives.length === localArchives.length) {
    return false;
  }
  await saveLocalArchives(nextArchives);
  return true;
}

async function createFolder(name) {
  const cleanName = normalizeFolderName(name);
  const library = await getArchiveLibrary();
  if (library.folders.length >= MAX_FOLDERS) {
    throw new Error(`最多创建 ${MAX_FOLDERS} 个文件夹`);
  }

  const now = new Date().toISOString();
  const folder = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    id: createRecordId(),
    name: cleanName,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
  await chrome.storage.sync.set({ [getFolderKey(folder.id)]: folder });
  return folder;
}

async function renameFolder(folderId, name) {
  const folder = await getFolder(folderId);
  if (!folder) {
    return null;
  }
  const updatedFolder = {
    ...folder,
    name: normalizeFolderName(name),
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.sync.set({ [getFolderKey(folderId)]: updatedFolder });
  return updatedFolder;
}

async function deleteFolder(folderId) {
  const folder = await getFolder(folderId);
  if (!folder) {
    return false;
  }

  const now = new Date().toISOString();
  const syncData = await chrome.storage.sync.get(null);
  const updates = {
    [getFolderKey(folderId)]: { ...folder, updatedAt: now, deletedAt: now }
  };

  for (const [key, record] of Object.entries(syncData)) {
    if (key.startsWith(SYNC_ARCHIVE_PREFIX) && !record?.deletedAt && record?.folderId === folderId) {
      updates[key] = { ...record, folderId: null, updatedAt: now };
    }
  }
  await chrome.storage.sync.set(updates);

  const localArchives = await getLocalArchives();
  let localChanged = false;
  const nextLocalArchives = localArchives.map((archive) => {
    if (archive.folderId !== folderId) {
      return archive;
    }
    localChanged = true;
    return { ...archive, folderId: null, updatedAt: now };
  });
  if (localChanged) {
    await saveLocalArchives(nextLocalArchives);
  }
  return true;
}

async function moveArchive(archiveId, folderId) {
  if (folderId && !(await getFolder(folderId))) {
    throw new Error("目标文件夹已经不存在");
  }

  await ensureArchiveMigration();
  const syncKey = getArchiveKey(archiveId);
  const syncData = await chrome.storage.sync.get(syncKey);
  const syncRecord = syncData[syncKey];
  const now = new Date().toISOString();
  if (syncRecord && !syncRecord.deletedAt) {
    const updatedRecord = { ...syncRecord, folderId: folderId || null, updatedAt: now };
    await chrome.storage.sync.set({ [syncKey]: updatedRecord });
    return { ...updatedRecord, storageArea: "sync" };
  }

  const localArchives = await getLocalArchives();
  const index = localArchives.findIndex((archive) => archive.id === archiveId);
  if (index === -1) {
    return null;
  }
  localArchives[index] = { ...localArchives[index], folderId: folderId || null, updatedAt: now };
  await saveLocalArchives(localArchives);
  return { ...localArchives[index], storageArea: "local" };
}

async function getArchiveLibrary() {
  await ensureArchiveMigration();
  const [syncData, localArchives, bytesInUse] = await Promise.all([
    chrome.storage.sync.get(null),
    getLocalArchives(),
    getSyncBytesInUse()
  ]);

  const folders = Object.entries(syncData)
    .filter(([key, value]) => key.startsWith(SYNC_FOLDER_PREFIX) && value && !value.deletedAt)
    .map(([, value]) => ({ ...value, storageArea: "sync" }))
    .sort(compareCreatedRecords);

  const knownFolderIds = new Set(folders.map((folder) => folder.id));
  const deletedArchiveIds = new Set();
  const syncArchives = [];
  for (const [key, record] of Object.entries(syncData)) {
    if (!key.startsWith(SYNC_ARCHIVE_PREFIX) || !record) {
      continue;
    }
    if (record.deletedAt) {
      deletedArchiveIds.add(record.id);
      continue;
    }
    syncArchives.push({
      ...record,
      folderId: knownFolderIds.has(record.folderId) ? record.folderId : null,
      storageArea: "sync"
    });
  }

  const syncArchiveIds = new Set(syncArchives.map((archive) => archive.id));
  const visibleLocalArchives = localArchives
    .filter((archive) => !syncArchiveIds.has(archive.id) && !deletedArchiveIds.has(archive.id))
    .map((archive) => ({
      ...archive,
      folderId: knownFolderIds.has(archive.folderId) ? archive.folderId : null,
      storageArea: "local"
    }));

  const archives = [...syncArchives, ...visibleLocalArchives].sort(compareCreatedRecords);
  return {
    archives: archives.map(toArchiveMetadata),
    folders,
    storageInfo: {
      bytesInUse,
      quotaBytes: chrome.storage.sync.QUOTA_BYTES || SYNC_QUOTA_BYTES,
      syncCount: syncArchives.length,
      localCount: visibleLocalArchives.length
    }
  };
}

async function getArchive(archiveId) {
  await ensureArchiveMigration();
  const syncData = await chrome.storage.sync.get(null);
  const record = syncData[getArchiveKey(archiveId)];
  if (record?.deletedAt) {
    return null;
  }
  if (record && !record.deletedAt) {
    const tabs = [];
    for (let index = 0; index < (record.chunkCount || 0); index += 1) {
      const chunk = syncData[getChunkKey(archiveId, index)];
      if (!chunk || !Array.isArray(chunk.tabs)) {
        throw new Error("这条同步存档的数据不完整，请等待 Chrome 完成同步后重试");
      }
      tabs.push(...chunk.tabs);
    }
    return { ...record, tabs, storageArea: "sync" };
  }

  const localArchives = await getLocalArchives();
  const localArchive = localArchives.find((archive) => archive.id === archiveId);
  return localArchive ? { ...localArchive, storageArea: "local" } : null;
}

async function getFolder(folderId) {
  if (!folderId) {
    return null;
  }
  await ensureArchiveMigration();
  const key = getFolderKey(folderId);
  const stored = await chrome.storage.sync.get(key);
  const folder = stored[key];
  return folder && !folder.deletedAt ? folder : null;
}

async function saveNewArchive(archive) {
  try {
    await saveArchiveToSync(archive);
    await removeLocalArchive(archive.id);
    return "sync";
  } catch (error) {
    console.warn("同步存档失败，已改存到本机", error);
    const localArchives = await getLocalArchives();
    localArchives.unshift({ ...archive, storageArea: undefined });
    await saveLocalArchives(localArchives.slice(0, MAX_ARCHIVES));
    return "local";
  }
}

async function saveArchiveToSync(archive) {
  const chunks = chunkArchiveTabs(archive.id, archive.tabs || []);
  const record = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    id: archive.id,
    folderId: archive.folderId || null,
    title: archive.title || "",
    color: archive.color || "grey",
    collapsed: Boolean(archive.collapsed),
    createdAt: archive.createdAt || new Date().toISOString(),
    updatedAt: archive.updatedAt || new Date().toISOString(),
    deletedAt: null,
    tabCount: archive.tabs?.length || archive.tabCount || 0,
    chunkCount: chunks.length
  };

  const items = { [getArchiveKey(archive.id)]: record };
  chunks.forEach((tabs, index) => {
    items[getChunkKey(archive.id, index)] = { archiveId: archive.id, index, tabs };
  });
  await chrome.storage.sync.set(items);
}

function chunkArchiveTabs(archiveId, tabs) {
  const chunks = [];
  let current = [];

  for (const tab of tabs) {
    const candidate = [...current, tab];
    const key = getChunkKey(archiveId, chunks.length);
    const bytes = getStorageItemBytes(key, { archiveId, index: chunks.length, tabs: candidate });
    if (bytes <= SYNC_SAFE_ITEM_BYTES) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error("某个标签页网址过长，无法写入 Chrome 同步存储");
    }
    chunks.push(current);
    current = [tab];
    const nextKey = getChunkKey(archiveId, chunks.length);
    if (getStorageItemBytes(nextKey, { archiveId, index: chunks.length, tabs: current }) > SYNC_SAFE_ITEM_BYTES) {
      throw new Error("某个标签页网址过长，无法写入 Chrome 同步存储");
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function removeArchiveChunks(archiveId, chunkCount) {
  if (!chunkCount) {
    return;
  }
  const keys = Array.from({ length: chunkCount }, (_, index) => getChunkKey(archiveId, index));
  await chrome.storage.sync.remove(keys);
}

async function ensureArchiveMigration() {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyArchives().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

async function migrateLegacyArchives() {
  const localData = await chrome.storage.local.get([
    MIGRATION_STORAGE_KEY,
    LEGACY_ARCHIVES_STORAGE_KEY,
    LOCAL_ARCHIVES_STORAGE_KEY
  ]);
  if (localData[MIGRATION_STORAGE_KEY]?.completed) {
    return;
  }

  const legacyArchives = Array.isArray(localData[LEGACY_ARCHIVES_STORAGE_KEY])
    ? localData[LEGACY_ARCHIVES_STORAGE_KEY]
    : [];
  const localFallback = Array.isArray(localData[LOCAL_ARCHIVES_STORAGE_KEY])
    ? localData[LOCAL_ARCHIVES_STORAGE_KEY]
    : [];
  const fallbackIds = new Set(localFallback.map((archive) => archive.id));
  const syncData = await chrome.storage.sync.get(null);

  for (const legacyArchive of legacyArchives.slice(0, MAX_ARCHIVES)) {
    const archive = normalizeLegacyArchive(legacyArchive);
    if (syncData[getArchiveKey(archive.id)] || fallbackIds.has(archive.id)) {
      continue;
    }
    try {
      await saveArchiveToSync(archive);
    } catch (error) {
      console.warn("旧存档无法同步，已保留在本机", error);
      localFallback.push(archive);
      fallbackIds.add(archive.id);
    }
  }

  await chrome.storage.local.set({
    [LOCAL_ARCHIVES_STORAGE_KEY]: localFallback.slice(0, MAX_ARCHIVES),
    [MIGRATION_STORAGE_KEY]: { completed: true, completedAt: new Date().toISOString() }
  });
}

function normalizeLegacyArchive(archive) {
  const now = new Date().toISOString();
  const tabs = Array.isArray(archive?.tabs)
    ? archive.tabs.filter((tab) => tab?.url).map((tab) => ({ title: tab.title || "", url: tab.url }))
    : [];
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    id: archive?.id || createRecordId(),
    folderId: null,
    title: archive?.title || "",
    color: archive?.color || "grey",
    collapsed: Boolean(archive?.collapsed),
    createdAt: archive?.createdAt || now,
    updatedAt: archive?.updatedAt || archive?.createdAt || now,
    deletedAt: null,
    tabCount: tabs.length,
    tabs
  };
}

async function getLocalArchives() {
  const stored = await chrome.storage.local.get(LOCAL_ARCHIVES_STORAGE_KEY);
  const archives = stored[LOCAL_ARCHIVES_STORAGE_KEY];
  return Array.isArray(archives) ? archives : [];
}

async function saveLocalArchives(archives) {
  await chrome.storage.local.set({ [LOCAL_ARCHIVES_STORAGE_KEY]: archives.slice(0, MAX_ARCHIVES) });
}

async function removeLocalArchive(archiveId) {
  const localArchives = await getLocalArchives();
  const nextArchives = localArchives.filter((archive) => archive.id !== archiveId);
  if (nextArchives.length !== localArchives.length) {
    await saveLocalArchives(nextArchives);
  }
}

async function getSyncBytesInUse() {
  if (typeof chrome.storage.sync.getBytesInUse !== "function") {
    return 0;
  }
  return chrome.storage.sync.getBytesInUse(null);
}

async function getTabGroupSnapshot(activeTab) {
  if (!activeTab || activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return null;
  }

  const [group, tabs] = await Promise.all([
    chrome.tabGroups.get(activeTab.groupId),
    chrome.tabs.query({ groupId: activeTab.groupId })
  ]);

  tabs.sort((left, right) => left.index - right.index);
  if (tabs.length === 0) {
    throw new Error("标签组中没有可存档的标签页");
  }

  for (const tab of tabs) {
    if (!tab.pendingUrl && !tab.url) {
      throw new Error(`无法读取标签页 ${tab.id} 的网址`);
    }
  }
  return { group, tabs };
}

async function getActiveTab(options = {}) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab && options.required !== false) {
    throw new Error("没有找到当前标签页");
  }
  return activeTab || null;
}

function normalizeFolderName(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    throw new Error("文件夹名称不能为空");
  }
  if (cleanName.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(`文件夹名称不能超过 ${MAX_FOLDER_NAME_LENGTH} 个字符`);
  }
  return cleanName;
}

function toArchiveMetadata(archive) {
  return {
    id: archive.id,
    folderId: archive.folderId || null,
    title: archive.title || "",
    color: archive.color || "grey",
    collapsed: Boolean(archive.collapsed),
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    tabCount: archive.tabCount || archive.tabs?.length || 0,
    storageArea: archive.storageArea || "sync"
  };
}

function compareCreatedRecords(left, right) {
  return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

function getArchiveKey(archiveId) {
  return `${SYNC_ARCHIVE_PREFIX}${archiveId}`;
}

function getChunkKey(archiveId, index) {
  return `${SYNC_CHUNK_PREFIX}${archiveId}.${index}`;
}

function getFolderKey(folderId) {
  return `${SYNC_FOLDER_PREFIX}${folderId}`;
}

function getStorageItemBytes(key, value) {
  return getUtf8ByteLength(key) + getUtf8ByteLength(JSON.stringify(value));
}

function getUtf8ByteLength(value) {
  let bytes = 0;
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function createRecordId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function showBadge(text, color, tabId) {
  const details = tabId === undefined ? {} : { tabId };
  await Promise.all([
    chrome.action.setBadgeText({ ...details, text }),
    chrome.action.setBadgeBackgroundColor({ ...details, color })
  ]);

  setTimeout(() => {
    chrome.action.setBadgeText({ ...details, text: "" }).catch(() => {});
  }, BADGE_CLEAR_DELAY_MS);
}

function getErrorMessage(error) {
  return error?.message || String(error);
}
