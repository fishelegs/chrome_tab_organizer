const BADGE_CLEAR_DELAY_MS = 2500;
const ARCHIVES_STORAGE_KEY = "tabGroupArchives";
const MAX_ARCHIVES = 100;

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

  if (message.type === "get-archives") {
    return { ok: true, archives: await getArchives() };
  }

  if (message.type === "restore-archived-tab-group") {
    const result = await restoreArchivedTabGroup(message.archiveId);
    return result ? { ok: true, message: "已恢复存档" } : { ok: false, error: "没有找到这条存档" };
  }

  if (message.type === "delete-archive") {
    const result = await deleteArchive(message.archiveId);
    return result ? { ok: true, message: "已删除存档" } : { ok: false, error: "没有找到这条存档" };
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
    const result = await archiveCurrentTabGroup(activeTab);
    return result ? { ok: true, message: "已存档并收起" } : { ok: false, error: "当前没有标签组" };
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

async function archiveCurrentTabGroup(activeTab) {
  const snapshot = await getTabGroupSnapshot(activeTab);
  if (!snapshot) {
    await showBadge("无组", "#5f6368", activeTab?.id);
    return null;
  }

  const archive = {
    id: createArchiveId(),
    title: snapshot.group.title || "",
    color: snapshot.group.color,
    collapsed: snapshot.group.collapsed,
    createdAt: new Date().toISOString(),
    tabCount: snapshot.tabs.length,
    tabs: snapshot.tabs.map((tab) => ({
      title: tab.title || "",
      url: tab.pendingUrl || tab.url
    }))
  };

  const archives = await getArchives();
  archives.unshift(archive);
  await saveArchives(archives);
  await chrome.tabs.remove(snapshot.tabs.map((tab) => tab.id));
  await showBadge("存", "#188038");
  return archive;
}

async function restoreArchivedTabGroup(archiveId) {
  const archives = await getArchives();
  const archive = archives.find((item) => item.id === archiveId);
  if (!archive) {
    return null;
  }
  if (!Array.isArray(archive.tabs) || archive.tabs.length === 0) {
    throw new Error("这条存档没有可恢复的标签页");
  }

  const activeTab = await getActiveTab({ required: false });
  const insertionIndex = activeTab ? activeTab.index + 1 : undefined;
  const createdTabIds = [];

  try {
    for (let offset = 0; offset < archive.tabs.length; offset += 1) {
      const archivedTab = archive.tabs[offset];
      const createProperties = {
        url: archivedTab.url,
        active: false
      };

      if (activeTab) {
        createProperties.windowId = activeTab.windowId;
        createProperties.index = insertionIndex + offset;
      }

      const createdTab = await chrome.tabs.create(createProperties);
      createdTabIds.push(createdTab.id);
    }

    const groupProperties = { tabIds: createdTabIds };
    if (activeTab) {
      groupProperties.createProperties = { windowId: activeTab.windowId };
    }

    const newGroupId = await chrome.tabs.group(groupProperties);
    await chrome.tabGroups.update(newGroupId, {
      title: archive.title || "",
      color: archive.color,
      collapsed: archive.collapsed
    });

    await chrome.tabs.update(createdTabIds[0], { active: true });
    await showBadge("✓", "#188038", createdTabIds[0]);

    return { newGroupId, createdTabIds };
  } catch (error) {
    if (createdTabIds.length > 0) {
      await chrome.tabs.remove(createdTabIds).catch(() => {});
    }
    throw error;
  }
}

async function deleteArchive(archiveId) {
  const archives = await getArchives();
  const nextArchives = archives.filter((item) => item.id !== archiveId);
  if (nextArchives.length === archives.length) {
    return false;
  }

  await saveArchives(nextArchives);
  return true;
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

async function getArchives() {
  const stored = await chrome.storage.local.get(ARCHIVES_STORAGE_KEY);
  const archives = stored[ARCHIVES_STORAGE_KEY];
  return Array.isArray(archives) ? archives : [];
}

async function saveArchives(archives) {
  await chrome.storage.local.set({
    [ARCHIVES_STORAGE_KEY]: archives.slice(0, MAX_ARCHIVES)
  });
}

async function getActiveTab(options = {}) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab && options.required !== false) {
    throw new Error("没有找到当前标签页");
  }

  return activeTab || null;
}

function createArchiveId() {
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
