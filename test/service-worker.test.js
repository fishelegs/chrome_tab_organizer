const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadWorker(overrides = {}) {
  const calls = [];
  const storageState = {
    tabGroupArchives: overrides.archives || []
  };
  const sourceTabs = overrides.sourceTabs || [
    { id: 11, index: 2, title: "One", url: "https://example.com/one" },
    { id: 12, index: 3, title: "Two", url: "https://example.com/two" }
  ];
  const chrome = {
    action: {
      onClicked: { addListener() {} },
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
      local: {
        get: async (key) => {
          calls.push(["storageGet", key]);
          if (typeof key === "string") {
            return { [key]: storageState[key] };
          }
          return {};
        },
        set: async (items) => {
          calls.push(["storageSet", items]);
          Object.assign(storageState, items);
        }
      }
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
        return 8;
      },
      remove: async (ids) => calls.push(["remove", ids]),
      update: async (...args) => calls.push(["tabUpdate", ...args])
    }
  };

  Object.assign(chrome.tabs, overrides.tabs);
  Object.assign(chrome.tabGroups, overrides.tabGroups);

  const context = vm.createContext({
    chrome,
    console,
    setTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
  vm.runInContext(source, context);
  return { context, calls, storageState };
}

async function testSuccessfulCopy() {
  const { context, calls } = loadWorker();
  await context.duplicateTabGroup({ id: 12, windowId: 3, groupId: 7 });

  const creates = calls.filter(([name]) => name === "create");
  assert.deepEqual(JSON.parse(JSON.stringify(creates)), [
    ["create", { windowId: 3, index: 4, url: "https://example.com/one", active: false }],
    ["create", { windowId: 3, index: 5, url: "https://example.com/two", active: false }]
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "group"))),
    ["group", { tabIds: [101, 102], createProperties: { windowId: 3 } }]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "update"))),
    ["update", 8, { title: "工作", color: "blue", collapsed: true }]
  );
  assert.equal(
    calls.some(([name, details]) => name === "badgeText" && details.tabId === 12 && details.text === "✓"),
    true
  );
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

  const creates = calls.filter(([name]) => name === "create");
  assert.deepEqual(JSON.parse(JSON.stringify(creates)), [
    ["create", { windowId: 3, index: 0, url: "https://example.com/one", active: false }],
    ["create", { windowId: 3, index: 1, url: "https://example.com/two", active: false }]
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "remove"))),
    ["remove", [11, 12]]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "tabUpdate"))),
    ["tabUpdate", 102, { active: true }]
  );
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

  await assert.rejects(
    context.duplicateTabGroup({ id: 12, windowId: 3, groupId: 7 }),
    /simulated failure/
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "remove"))),
    ["remove", [101]]
  );
}

async function testArchiveCurrentGroup() {
  const { context, calls, storageState } = loadWorker();
  await context.archiveCurrentTabGroup({ id: 12, windowId: 3, groupId: 7 });

  assert.equal(storageState.tabGroupArchives.length, 1);
  assert.equal(storageState.tabGroupArchives[0].title, "工作");
  assert.equal(storageState.tabGroupArchives[0].tabCount, 2);
  assert.deepEqual(
    storageState.tabGroupArchives[0].tabs.map((tab) => tab.url),
    ["https://example.com/one", "https://example.com/two"]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "remove"))),
    ["remove", [11, 12]]
  );
  assert.equal(
    calls.some(([name, details]) => name === "badgeText" && !("tabId" in details) && details.text === "存"),
    true
  );
}

async function testRestoreArchivedGroup() {
  const archive = {
    id: "archive-1",
    title: "资料",
    color: "green",
    collapsed: false,
    createdAt: "2026-07-13T00:00:00.000Z",
    tabCount: 2,
    tabs: [
      { title: "A", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" }
    ]
  };
  const { context, calls, storageState } = loadWorker({ archives: [archive] });
  await context.restoreArchivedTabGroup("archive-1");

  const creates = calls.filter(([name]) => name === "create");
  assert.deepEqual(JSON.parse(JSON.stringify(creates)), [
    ["create", { url: "https://example.com/a", active: false, windowId: 3, index: 4 }],
    ["create", { url: "https://example.com/b", active: false, windowId: 3, index: 5 }]
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "group"))),
    ["group", { tabIds: [101, 102], createProperties: { windowId: 3 } }]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find(([name]) => name === "update"))),
    ["update", 8, { title: "资料", color: "green", collapsed: false }]
  );
  assert.equal(storageState.tabGroupArchives.length, 1);
}

async function testDeleteArchive() {
  const { context, storageState } = loadWorker({
    archives: [
      { id: "archive-1", tabs: [{ url: "https://example.com/a" }] },
      { id: "archive-2", tabs: [{ url: "https://example.com/b" }] }
    ]
  });
  assert.equal(await context.deleteArchive("archive-1"), true);
  assert.deepEqual(storageState.tabGroupArchives.map((archive) => archive.id), ["archive-2"]);
  assert.equal(await context.deleteArchive("missing"), false);
}

Promise.resolve()
  .then(testSuccessfulCopy)
  .then(testUngroupedTab)
  .then(testPinToFront)
  .then(testRollbackOnFailure)
  .then(testArchiveCurrentGroup)
  .then(testRestoreArchivedGroup)
  .then(testDeleteArchive)
  .then(() => console.log("service-worker tests passed"));
