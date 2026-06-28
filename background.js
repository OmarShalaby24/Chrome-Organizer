// Background service worker: auto-groups tabs into Chrome tab groups by domain.

importScripts("common.js");

const {
  findRuleForUrl,
  loadRules,
} = self.TabOrganizer;

// In-memory cache of rules; refreshed from storage and on storage changes.
let rulesCache = [];

async function refreshRules() {
  rulesCache = await loadRules();
}

// Promise wrappers around the callback-style tab APIs.
function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab);
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

function queryGroups(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabGroups.query(queryInfo, (groups) => resolve(groups || []));
  });
}

function groupTabs(options) {
  return new Promise((resolve) => {
    chrome.tabs.group(options, (groupId) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(groupId);
    });
  });
}

function updateGroup(groupId, props) {
  return new Promise((resolve) => {
    chrome.tabGroups.update(groupId, props, () => {
      // Ignore errors (e.g. group disappeared).
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// Find an existing group in the given window whose title matches groupName.
async function findGroupInWindow(windowId, groupName) {
  const groups = await queryGroups({ windowId });
  return groups.find((g) => g.title === groupName) || null;
}

// Assign a tab to the group described by `rule`, creating the group if needed.
async function assignTabToGroup(tab, rule) {
  if (!tab || tab.id === undefined) return;

  // If the tab is already in a group with the right title, do nothing
  // (prevents loops with onUpdated).
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    const existing = await queryGroups({ windowId: tab.windowId });
    const current = existing.find((g) => g.id === tab.groupId);
    if (current && current.title === rule.groupName) return;
  }

  const target = await findGroupInWindow(tab.windowId, rule.groupName);

  if (target) {
    await groupTabs({ groupId: target.id, tabIds: tab.id });
  } else {
    const groupId = await groupTabs({
      createProperties: { windowId: tab.windowId },
      tabIds: tab.id,
    });
    if (groupId !== null && groupId !== undefined) {
      await updateGroup(groupId, { title: rule.groupName, color: rule.color });
    }
  }
}

// Evaluate a single tab against the rules and group it if matched.
async function processTab(tabOrId) {
  let tab = tabOrId;
  if (typeof tabOrId === "number") {
    tab = await getTab(tabOrId);
  }
  if (!tab || !tab.url) return;

  const rule = findRuleForUrl(tab.url, rulesCache);
  if (!rule) return;
  await assignTabToGroup(tab, rule);
}

// Re-scan every open tab and group matches (used after rule changes).
async function regroupAllTabs() {
  await refreshRules();
  const tabs = await queryTabs({});
  for (const tab of tabs) {
    await processTab(tab);
  }
}

// --- Event listeners (registered at top level so they survive worker restarts) ---

chrome.runtime.onInstalled.addListener(() => {
  refreshRules();
});

chrome.runtime.onStartup.addListener(() => {
  refreshRules();
});

// New tab (covers links that open a new tab).
chrome.tabs.onCreated.addListener((tab) => {
  // The URL may not be ready yet; onUpdated will catch it. Try anyway.
  if (tab.url) {
    processTab(tab);
  }
});

// Tab navigation / load. Act once the URL is known.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    processTab(tab);
  }
});

// Keep the rules cache fresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[self.TabOrganizer.STORAGE_KEY]) {
    rulesCache = changes[self.TabOrganizer.STORAGE_KEY].newValue || [];
  }
});

// Popup asks us to re-scan after the user changes rules.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "regroupAll") {
    regroupAllTabs().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

// Initial load.
refreshRules();
