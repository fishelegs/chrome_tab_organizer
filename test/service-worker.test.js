const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ARCHIVE_PREFIX = "tga.v2.archive.";
const CHUNK_PREFIX = "tga.v2.tabs.";
const FOLDER_PREFIX = "tga.v2.folder.";

function loadWorker(overrides = {}) {
  const calls = [];
  const localState = {
    tabGroupArchives: overrides.legacyArchives || [],
    tabGroupArchivesLocalV2: overrides.localArchives || [],
    ...(overrides.migrationCompleted === false
      ? {}
      : { tabGroupArchivesMigrationV2: { completed: true } })
  };
  const syncState = { ...(overrides.syncState || {}) };
  const sourceTabs = overrides.sourceTabs || [
    { id: 11, index: 2, title: "One", url: "https://example.com/one" },
    { id: 12, index: 3, title: "Two", url: "https://example.com/two" }
  ];

  const local = createStorageArea("local", localState, calls, overrides);
  const sync = createStorageArea("sync", syncState, calls, overrides);
  sync.QUOTA_BYTES = 102400;
  sync.QUOTA_BYTES_PER_ITEM = 8192;

  const chrome = {
    action: {
      setBadgeText: async (details) => {
        assert.equal("windowId" in details, false);
        calls.push(["badgeText", details]);
      },
      setBadgeBackgroundColor: async (details) => {
        assert.equal("windowId" in details, false);
        calls.push(["badgeColor", details]);
      }
    },
    commands: { onCommand: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local,
      sync,
      onChanged: { addListener() {} }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async () => ({ id: 7, windowId: 3, title: "工作", color: "blue", collapsed: true }),
      update: async (...args) => calls.push(["update", ...args])
    },
    tabs: {
      query: async (details) => {
        if (details?.active) {
          return [{ id: 12, windowId: 3, index: 3, groupId: 7, url: "https://example.com/two" }];
        }
        return sourceTabs;
      },
      create: async (details) => {
        calls.push(["create", details]);
        return { id: 100 + calls.filter(([name]) => name === "create").length };
      },
      group: async (details) => {
        calls.push(["group", details]);
        return 7 + calls.filter(([name]) => name === "group").length;
      },
      remove: async (ids) => calls.push(["remove", ids]),
      update: async (...args) => calls.push(["tabUpdate", ...args])
    }
  };

  Object.assign(chrome.tabs, overrides.tabs);
  Object.assign(chrome.tabGroups, overrides.tabGroups);

  const context = vm.createContext({
    chrome,
    console: { ...console, warn() {} },
    setTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
  vm.runInContext(source, context);
  return { context, calls, localState, syncState };
}

function createStorageArea(name, state, calls, overrides) {
  return {
    get: async (keys) => {
      calls.push([`${name}Get`, keys]);
      if (keys === null || keys === undefined) {
        return { ...state };
      }
      if (typeof keys === "string") {
        return { [keys]: state[keys] };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }
      return Object.fromEntries(Object.keys(keys).map((key) => [key, state[key] ?? keys[key]]));
    },
    set: async (items) => {
      calls.push([`${name}Set`, items]);
      if (name === "sync" && overrides.syncSetError) {
        throw new Error(overrides.syncSetError);
      }
      Object.assign(state, items);
    },
    remove: async (keys) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      calls.push([`${name}Remove`, keyList]);
      keyList.forEach((key) => delete state[key]);
    },
    getBytesInUse: async () => Buffer.byteLength(JSON.stringify(state))
  };
}

function syncArchive(id, options = {}) {
  const tabs = options.tabs || [{ title: "A", url: "https://example.com/a" }];
  const now = "2026-07-13T00:00:00.000Z";
  return {
    [`${ARCHIVE_PREFIX}${id}`]: {
      schemaVersion: 2,
      id,
      folderId: options.folderId || null,
      title: options.title || "资料",
      color: options.color || "green",
      collapsed: false,
      createdAt: options.createdAt || now,
      updatedAt: now,
      deletedAt: options.deletedAt || null,
      tabCount: tabs.length,
      chunkCount: options.deletedAt ? 0 : 1
    },
    ...(!options.deletedAt
      ? {
          [`${CHUNK_PREFIX}${id}.0`]: {
            archiveId: id,
            index: 0,
            tabs
          }
        }
      : {})
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testSuccessfulCopy() {
  const { context, calls } = loadWorker();
  await context.duplicateTabGroup({ id: 12, windowId: 3, groupId: 7 });

  const creates = calls.filter(([name]) => name === "create");
  assert.deepEqual(plain(creates), [
    ["create", { windowId: 3, index: 4, url: "https://example.com/one", active: false }],
    ["create", { windowId: 3, index: 5, url: "https://example.com/two", active: false }]
  ]);
  assert.deepEqual(plain(calls.find(([name]) => name === "group")), [
    "group",
    { tabIds: [101, 102], createProperties: { windowId: 3 } }
  ]);
  assert.deepEqual(plain(calls.find(([name]) => name === "update")), [
    "update",
    8,
    { title: "工作", color: "blue", collapsed: true }
  ]);
}

async function testUngroupedTab() {
  const { context, calls } = loadWorker();
  await context.duplicateTabGroup({ id: 12, windowId: 3, groupId: -1 });
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(
    calls.some(([name, details]) => name === "badgeText" && details.tabId === 12 && details.text === "无组"),
    true
  );
}

async function testPinToFront() {
  const { context, calls } = loadWorker();
  await context.pinTabGroupToFront({ id: 12, windowId: 3, groupId: 7 });
  assert.deepEqual(plain(calls.filter(([name]) => name === "create")), [
    ["create", { windowId: 3, index: 0, url: "https://example.com/one", active: false }],
    ["create", { windowId: 3, index: 1, url: "https://example.com/two", active: false }]
  ]);
  assert.deepEqual(plain(calls.find(([name]) => name === "remove")), ["remove", [11, 12]]);
  assert.deepEqual(plain(calls.find(([name]) => name === "tabUpdate")), [
    "tabUpdate",
    102,
    { active: true }
  ]);
}

async function testRollbackOnFailure() {
  let createCount = 0;
  const { context, calls } = loadWorker({
    tabs: {
      create: async (details) => {
        createCount += 1;
        calls.push(["create", details]);
        if (createCount === 2) throw new Error("simulated failure");
        return { id: 101 };
      }
    }
  });

  await assert.rejects(context.duplicateTabGroup({ id: 12, windowId: 3, groupId: 7 }), /simulated failure/);
  assert.deepEqual(plain(calls.find(([name]) => name === "remove")), ["remove", [101]]);
}

async function testArchiveCurrentGroupUsesSyncChunks() {
  const { context, calls, syncState } = loadWorker();
  const result = await context.archiveCurrentTabGroup({ id: 12, windowId: 3, groupId: 7 });

  assert.equal(result.storageArea, "sync");
  const record = Object.values(syncState).find((value) => value?.id === result.id && "chunkCount" in value);
  assert.equal(record.title, "工作");
  assert.equal(record.tabCount, 2);
  assert.equal(record.chunkCount, 1);
  const chunk = Object.values(syncState).find((value) => value?.archiveId === result.id);
  assert.deepEqual(plain(chunk.tabs.map((tab) => tab.url)), [
    "https://example.com/one",
    "https://example.com/two"
  ]);
  assert.deepEqual(plain(calls.find(([name]) => name === "remove")), ["remove", [11, 12]]);
}

async function testSyncFailureFallsBackToLocal() {
  const { context, localState } = loadWorker({ syncSetError: "quota exceeded" });
  const result = await context.archiveCurrentTabGroup({ id: 12, windowId: 3, groupId: 7 });
  assert.equal(result.storageArea, "local");
  assert.equal(localState.tabGroupArchivesLocalV2.length, 1);
  assert.equal(localState.tabGroupArchivesLocalV2[0].title, "工作");
}

async function testRestoreArchivedGroup() {
  const { context, calls } = loadWorker({
    syncState: syncArchive("archive-1", {
      tabs: [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" }
      ]
    })
  });
  await context.restoreArchivedTabGroup("archive-1");

  assert.deepEqual(plain(calls.filter(([name]) => name === "create")), [
    ["create", { url: "https://example.com/a", active: false, windowId: 3, index: 4 }],
    ["create", { url: "https://example.com/b", active: false, windowId: 3, index: 5 }]
  ]);
  assert.deepEqual(plain(calls.find(([name]) => name === "group")), [
    "group",
    { tabIds: [101, 102], createProperties: { windowId: 3 } }
  ]);
}

async function testDeleteArchiveCreatesTombstone() {
  const { context, syncState } = loadWorker({ syncState: syncArchive("archive-1") });
  assert.equal(await context.deleteArchive("archive-1"), true);
  assert.ok(syncState[`${ARCHIVE_PREFIX}archive-1`].deletedAt);
  assert.equal(syncState[`${CHUNK_PREFIX}archive-1.0`], undefined);
  assert.equal(await context.deleteArchive("missing"), false);
}

async function testLegacyMigration() {
  const legacyArchive = {
    id: "legacy-1",
    title: "旧存档",
    color: "blue",
    collapsed: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    tabs: [{ title: "旧页面", url: "https://example.com/legacy" }]
  };
  const { context, localState, syncState } = loadWorker({
    migrationCompleted: false,
    legacyArchives: [legacyArchive]
  });
  const library = await context.getArchiveLibrary();
  assert.equal(library.archives.length, 1);
  assert.equal(library.archives[0].title, "旧存档");
  assert.equal(syncState[`${ARCHIVE_PREFIX}legacy-1`].chunkCount, 1);
  assert.equal(localState.tabGroupArchivesMigrationV2.completed, true);
  assert.equal(localState.tabGroupArchives.length, 1);
}

async function testFolderTreeAndMove() {
  const { context } = loadWorker({ syncState: syncArchive("archive-1") });
  const folder = await context.createFolder("项目 A");
  const moved = await context.moveArchive("archive-1", folder.id);
  assert.equal(moved.folderId, folder.id);

  const library = await context.getArchiveLibrary();
  assert.equal(library.folders[0].name, "项目 A");
  assert.equal(library.archives[0].folderId, folder.id);

  const renamed = await context.renameFolder(folder.id, "项目 B");
  assert.equal(renamed.name, "项目 B");

  assert.equal(await context.deleteFolder(folder.id), true);
  const afterDelete = await context.getArchiveLibrary();
  assert.equal(afterDelete.folders.length, 0);
  assert.equal(afterDelete.archives[0].folderId, null);
}

async function testSecondDeviceCanReadSyncedArchive() {
  const firstDevice = loadWorker();
  await firstDevice.context.archiveCurrentTabGroup({ id: 12, windowId: 3, groupId: 7 });

  const secondDevice = loadWorker({ syncState: firstDevice.syncState });
  const library = await secondDevice.context.getArchiveLibrary();
  assert.equal(library.archives.length, 1);
  assert.equal(library.archives[0].title, "工作");
  assert.equal(library.archives[0].storageArea, "sync");
}

async function testRestoreFolderCreatesSiblingGroups() {
  const folder = {
    schemaVersion: 2,
    id: "folder-1",
    name: "项目",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null
  };
  const { context, calls } = loadWorker({
    syncState: {
      [`${FOLDER_PREFIX}folder-1`]: folder,
      ...syncArchive("archive-1", {
        folderId: "folder-1",
        createdAt: "2026-07-03T00:00:00.000Z",
        tabs: [{ title: "A", url: "https://example.com/a" }]
      }),
      ...syncArchive("archive-2", {
        folderId: "folder-1",
        createdAt: "2026-07-02T00:00:00.000Z",
        tabs: [{ title: "B", url: "https://example.com/b" }]
      })
    }
  });

  const result = await context.restoreFolder("folder-1");
  assert.equal(result.groupCount, 2);
  assert.deepEqual(plain(calls.filter(([name]) => name === "create")), [
    ["create", { url: "https://example.com/a", active: false, windowId: 3, index: 4 }],
    ["create", { url: "https://example.com/b", active: false, windowId: 3, index: 5 }]
  ]);
  assert.equal(calls.filter(([name]) => name === "group").length, 2);
}

async function testLargeArchiveIsChunkedUnderItemLimit() {
  const { context } = loadWorker();
  const tabs = Array.from({ length: 40 }, (_, index) => ({
    title: `页面 ${index} ${"标".repeat(80)}`,
    url: `https://example.com/${index}/${"a".repeat(300)}`
  }));
  const chunks = context.chunkArchiveTabs("large-archive", tabs);
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk, index) => {
    const key = context.getChunkKey("large-archive", index);
    const bytes = context.getStorageItemBytes(key, {
      archiveId: "large-archive",
      index,
      tabs: chunk
    });
    assert.ok(bytes <= 7600);
  });
}

async function testTombstoneHidesLocalDuplicate() {
  const deletedAt = "2026-07-14T00:00:00.000Z";
  const { context } = loadWorker({
    syncState: syncArchive("same-id", { deletedAt }),
    localArchives: [
      {
        id: "same-id",
        title: "不应复活",
        createdAt: "2026-07-01T00:00:00.000Z",
        tabs: [{ url: "https://example.com" }]
      }
    ]
  });
  const library = await context.getArchiveLibrary();
  assert.equal(library.archives.length, 0);
}

Promise.resolve()
  .then(testSuccessfulCopy)
  .then(testUngroupedTab)
  .then(testPinToFront)
  .then(testRollbackOnFailure)
  .then(testArchiveCurrentGroupUsesSyncChunks)
  .then(testSyncFailureFallsBackToLocal)
  .then(testRestoreArchivedGroup)
  .then(testDeleteArchiveCreatesTombstone)
  .then(testLegacyMigration)
  .then(testFolderTreeAndMove)
  .then(testSecondDeviceCanReadSyncedArchive)
  .then(testRestoreFolderCreatesSiblingGroups)
  .then(testLargeArchiveIsChunkedUnderItemLimit)
  .then(testTombstoneHidesLocalDuplicate)
  .then(() => console.log("service-worker tests passed"));
