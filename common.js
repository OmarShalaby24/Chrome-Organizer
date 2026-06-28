// Shared helpers used by both the background service worker (via importScripts)
// and the popup (via a <script> tag).

// Chrome's allowed tab-group colors.
const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

const STORAGE_KEY = "rules";

// Generate a reasonably unique id for a rule.
function generateRuleId() {
  return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Normalize a single domain string: lower-case, trim, strip protocol/path/leading "www.".
function normalizeDomain(raw) {
  if (!raw) return "";
  let d = String(raw).trim().toLowerCase();
  if (!d) return "";
  // Strip protocol if a full URL was pasted.
  d = d.replace(/^[a-z]+:\/\//, "");
  // Strip any path/query/port.
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.split(":")[0];
  // Strip leading "www." so it behaves like a suffix rule.
  d = d.replace(/^www\./, "");
  return d;
}

// Parse a free-form domains string (comma / whitespace / newline separated) into
// a de-duplicated array of normalized domains.
function parseDomains(input) {
  if (!input) return [];
  const parts = String(input)
    .split(/[\s,]+/)
    .map(normalizeDomain)
    .filter(Boolean);
  return Array.from(new Set(parts));
}

// Extract the hostname from a URL, or "" if it isn't an http(s) URL.
function getHostname(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

// True if `hostname` equals `domain` or is a subdomain of it.
function hostMatchesDomain(hostname, domain) {
  if (!hostname || !domain) return false;
  if (hostname === domain) return true;
  return hostname.endsWith("." + domain);
}

// Find the first rule whose domains match the given URL's hostname.
function findRuleForUrl(url, rules) {
  const hostname = getHostname(url);
  if (!hostname) return null;
  for (const rule of rules) {
    for (const domain of rule.domains) {
      if (hostMatchesDomain(hostname, domain)) {
        return rule;
      }
    }
  }
  return null;
}

// Load rules from sync storage (returns a Promise<array>).
function loadRules() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_KEY, (data) => {
      const rules = (data && Array.isArray(data[STORAGE_KEY])) ? data[STORAGE_KEY] : [];
      resolve(rules);
    });
  });
}

// Save rules to sync storage (returns a Promise).
function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: rules }, () => resolve());
  });
}

// Make helpers available when loaded as a module-less script in the popup.
if (typeof self !== "undefined") {
  self.TabOrganizer = {
    GROUP_COLORS,
    STORAGE_KEY,
    generateRuleId,
    normalizeDomain,
    parseDomains,
    getHostname,
    hostMatchesDomain,
    findRuleForUrl,
    loadRules,
    saveRules,
  };
}
