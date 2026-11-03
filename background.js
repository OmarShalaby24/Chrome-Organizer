// Background service worker: auto-groups tabs into Chrome tab groups by domain.

importScripts("common.js");

(() => {
const {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  findRuleForUrl,
  getHostname,
  loadRules,
  loadSettings,
  normalizeSettings,
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

// Same pattern for the user's settings.
let settingsCache = { ...DEFAULT_SETTINGS };
let settingsReady = null;

async function refreshSettings() {
  settingsCache = await loadSettings();
}

function ensureSettingsLoaded() {
  if (!settingsReady) {
    settingsReady = refreshSettings();
  }
  return settingsReady;
}

function ensureStateLoaded() {
  return Promise.all([ensureRulesLoaded(), ensureSettingsLoaded()]);
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

function ungroupTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.ungroup(tabId, () => {
      if (chrome.runtime.lastError) {
        logError("tabs.ungroup", chrome.runtime.lastError);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// index -1 places the tab last in its window.
function moveTabToEnd(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.move(tabId, { index: -1 }, () => {
      if (chrome.runtime.lastError) {
        logError("tabs.move", chrome.runtime.lastError);
        resolve(false);
      } else {
        resolve(true);
      }
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

// Take a tab out of one of our rule-based groups and put it last in its window.
// Only groups whose title matches a rule are touched, so ungrouped tabs and
// groups the user made by hand are left alone. Returns true if the tab was moved.
async function evictFromManagedGroup(tab, url) {
  if (!settingsCache.moveUnmatchedToEnd) return false;
  // about:blank, the new-tab page and other non-web pages say nothing about
  // where a tab belongs.
  if (!getHostname(url)) return false;
  if (tab.groupId === undefined || tab.groupId === -1) return false;

  const groups = await queryGroups({ windowId: tab.windowId });
  const group = groups.find((g) => g.id === tab.groupId);
  if (!group || !rulesCache.some((r) => r.groupName === group.title)) return false;

  log("evicting", url, "from", group.title);
  if (!(await ungroupTab(tab.id))) return false;
  return moveTabToEnd(tab.id);
}

// Tab events arrive in bursts (created, URL change, load complete). Run the work
// for one tab strictly in order so an older decision can't land after a newer one.
const tabQueues = new Map();

function runForTab(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const result = previous.then(task);
  const tail = result
    .catch(() => {})
    .then(() => {
      if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
    });
  tabQueues.set(tabId, tail);
  return result;
}

// Evaluate a single tab against the rules and group it if matched.
// With `evict`, a tab that matches no rule is also taken out of its rule-based
// group and moved to the end of the window (see evictFromManagedGroup).
// Returns true if a matching rule was found and grouping was attempted.
async function processTab(tabOrId, { evict = false } = {}) {
  const tabId = typeof tabOrId === "number" ? tabOrId : tabOrId && tabOrId.id;
  if (tabId === undefined) return false;

  return runForTab(tabId, async () => {
    await ensureStateLoaded();
    // Re-read the tab: the event payload can be stale by the time this runs.
    const tab = await getTab(tabId);
    const url = tab && (tab.url || tab.pendingUrl);
    if (!url) return false;

    const rule = findRuleForUrl(url, rulesCache);
    if (!rule) {
      log("no rule for", url, "(", rulesCache.length, "rules loaded )");
      if (evict) {
        try {
          await evictFromManagedGroup(tab, url);
        } catch (err) {
          logError("evictFromManagedGroup failed for " + url, err);
        }
      }
      return false;
    }
    log("matched", url, "->", rule.groupName);
    try {
      await assignTabToGroup(tab, rule);
      return true;
    } catch (err) {
      logError("assignTabToGroup failed for " + url, err);
      return false;
    }
  });
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
  ensureStateLoaded();
});

chrome.runtime.onStartup.addListener(() => {
  ensureStateLoaded();
});

// New tab (covers links that open a new tab). A link tab usually has no committed
// URL yet, only a pendingUrl. A tab with an opener (e.g. a link opened from a
// grouped tab) that doesn't belong to the group it landed in is sent to the end.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url || tab.pendingUrl) {
    processTab(tab.id, { evict: tab.openerTabId !== undefined });
  }
});

// Tab navigation / load. A URL change re-checks group membership and may send the
// tab to the end; a plain load or reload only groups matches and never moves tabs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    processTab(tabId, { evict: true });
  } else if (changeInfo.status === "complete") {
    processTab(tabId);
  }
});

// Keep the rules and settings caches fresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes[self.TabOrganizer.STORAGE_KEY]) {
    rulesCache = changes[self.TabOrganizer.STORAGE_KEY].newValue || [];
    rulesReady = Promise.resolve();
  }
  if (changes[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
    settingsReady = Promise.resolve();
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
ensureStateLoaded();
})();
