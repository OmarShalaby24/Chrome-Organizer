// Background service worker: auto-groups tabs into Chrome tab groups by domain.

importScripts("common.js");

(() => {
const {
  findRuleForUrl,
  loadRules,
} = self.TabOrganizer;

const LOG = "[TabOrganizer]";
function log(...args) {
  console.log(LOG, ...args);
}
function logError(context, err) {
  console.error(LOG, context, err && err.message ? err.message : err);
}

// Brave/Chrome both expose chrome.tabGroups in MV3; warn loudly if it's missing
// so the failure is visible instead of silent.
if (!chrome.tabGroups) {
  console.error(
    LOG,
    "chrome.tabGroups API is NOT available. Tab grouping cannot work in this browser/configuration."
  );
} else {
  log("service worker started; tabGroups API available.");
}

// In-memory cache of rules; refreshed from storage and on storage changes.
let rulesCache = [];
// Promise that resolves once rules have been loaded at least once. Guards against
// a race where a tab event wakes the (MV3) worker and a listener runs before the
// initial async load has finished, leaving rulesCache empty.
let rulesReady = null;

async function refreshRules() {
  rulesCache = await loadRules();
}

function ensureRulesLoaded() {
  if (!rulesReady) {
    rulesReady = refreshRules();
  }
  return rulesReady;
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
    chrome.tabGroups.query(queryInfo, (groups) => {
      if (chrome.runtime.lastError) {
        logError("tabGroups.query", chrome.runtime.lastError);
        resolve([]);
      } else {
        resolve(groups || []);
      }
    });
  });
}

function groupTabs(options) {
  return new Promise((resolve) => {
    chrome.tabs.group(options, (groupId) => {
      if (chrome.runtime.lastError) {
        logError("tabs.group", chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(groupId);
      }
    });
  });
}

function updateGroup(groupId, props) {
  return new Promise((resolve) => {
    chrome.tabGroups.update(groupId, props, () => {
      if (chrome.runtime.lastError) {
        logError("tabGroups.update", chrome.runtime.lastError);
      }
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
// Returns true if a matching rule was found and grouping was attempted.
async function processTab(tabOrId) {
  await ensureRulesLoaded();
  let tab = tabOrId;
  if (typeof tabOrId === "number") {
    tab = await getTab(tabOrId);
  }
  if (!tab || !tab.url) return false;

  const rule = findRuleForUrl(tab.url, rulesCache);
  if (!rule) {
    log("no rule for", tab.url, "(", rulesCache.length, "rules loaded )");
    return false;
  }
  log("matched", tab.url, "->", rule.groupName);
  try {
    await assignTabToGroup(tab, rule);
    return true;
  } catch (err) {
    logError("assignTabToGroup failed for " + tab.url, err);
    return false;
  }
}

// Re-scan every open tab and group matches (used after rule changes).
// Returns the number of tabs that matched a rule.
async function regroupAllTabs() {
  await refreshRules();
  const tabs = await queryTabs({});
  let matched = 0;
  for (const tab of tabs) {
    if (await processTab(tab)) matched++;
  }
  log("regroupAllTabs: matched", matched, "of", tabs.length, "tabs");
  return matched;
}

// --- Event listeners (registered at top level so they survive worker restarts) ---

chrome.runtime.onInstalled.addListener(() => {
  ensureRulesLoaded();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRulesLoaded();
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
    rulesReady = Promise.resolve();
  }
});

// Popup asks us to re-scan after the user changes rules, or for status.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "regroupAll") {
    regroupAllTabs()
      .then((matched) =>
        sendResponse({ ok: true, matched, hasTabGroups: !!chrome.tabGroups })
      )
      .catch((err) => {
        logError("regroupAllTabs", err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true; // async response
  }
  if (message && message.type === "status") {
    sendResponse({ ok: true, hasTabGroups: !!chrome.tabGroups });
    return true;
  }
  return false;
});

// Initial load.
ensureRulesLoaded();
})();
