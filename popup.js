// Popup logic: manage domain→group rules and trigger re-grouping.

(() => {
const {
  GROUP_COLORS,
  generateRuleId,
  parseDomains,
  loadRules,
  saveRules,
} = self.TabOrganizer;

const els = {
  form: document.getElementById("rule-form"),
  formTitle: document.getElementById("form-title"),
  ruleId: document.getElementById("rule-id"),
  name: document.getElementById("group-name"),
  color: document.getElementById("group-color"),
  domains: document.getElementById("group-domains"),
  saveBtn: document.getElementById("save-btn"),
  cancelBtn: document.getElementById("cancel-btn"),
  error: document.getElementById("form-error"),
  list: document.getElementById("rules-list"),
  empty: document.getElementById("empty-state"),
  banner: document.getElementById("status-banner"),
  organizeBtn: document.getElementById("organize-btn"),
  organizeResult: document.getElementById("organize-result"),
  colorDropdown: document.getElementById("color-dropdown"),
  colorTrigger: document.getElementById("color-trigger"),
  colorTriggerDot: document.getElementById("color-trigger-dot"),
  colorTriggerLabel: document.getElementById("color-trigger-label"),
};

let rules = [];
let selectedColor = GROUP_COLORS[0];

function openColorMenu() {
  els.color.classList.remove("hidden");
  els.colorTrigger.setAttribute("aria-expanded", "true");
}

function closeColorMenu() {
  els.color.classList.add("hidden");
  els.colorTrigger.setAttribute("aria-expanded", "false");
}

function toggleColorMenu() {
  if (els.color.classList.contains("hidden")) {
    openColorMenu();
  } else {
    closeColorMenu();
  }
}

function setColor(color) {
  selectedColor = GROUP_COLORS.includes(color) ? color : GROUP_COLORS[0];
  for (const swatch of els.color.querySelectorAll(".color-swatch")) {
    const isSelected = swatch.dataset.color === selectedColor;
    swatch.classList.toggle("selected", isSelected);
    swatch.setAttribute("aria-checked", isSelected ? "true" : "false");
  }
  els.colorTriggerDot.className = "color-dot c-" + selectedColor;
  els.colorTriggerLabel.textContent =
    selectedColor.charAt(0).toUpperCase() + selectedColor.slice(1);
}

function populateColors() {
  for (const color of GROUP_COLORS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "color-swatch c-" + color;
    swatch.dataset.color = color;
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", "false");
    swatch.title = color.charAt(0).toUpperCase() + color.slice(1);
    swatch.setAttribute("aria-label", swatch.title);
    swatch.addEventListener("click", () => {
      setColor(color);
      closeColorMenu();
    });
    els.color.appendChild(swatch);
  }
  setColor(selectedColor);

  els.colorTrigger.addEventListener("click", toggleColorMenu);
  document.addEventListener("click", (event) => {
    if (!els.colorDropdown.contains(event.target)) closeColorMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeColorMenu();
  });
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}

function clearError() {
  els.error.textContent = "";
  els.error.classList.add("hidden");
}

function resetForm() {
  els.ruleId.value = "";
  els.name.value = "";
  setColor(GROUP_COLORS[0]);
  els.domains.value = "";
  els.formTitle.textContent = "Add a group";
  els.saveBtn.textContent = "Save group";
  els.cancelBtn.classList.add("hidden");
  closeColorMenu();
  clearError();
}

function renderRules() {
  els.list.innerHTML = "";

  if (rules.length === 0) {
    els.empty.classList.remove("hidden");
    return;
  }
  els.empty.classList.add("hidden");

  for (const rule of rules) {
    const li = document.createElement("li");
    li.className = "rule-item";

    const dot = document.createElement("span");
    dot.className = "color-dot c-" + rule.color;
    li.appendChild(dot);

    const info = document.createElement("div");
    info.className = "rule-info";

    const name = document.createElement("div");
    name.className = "rule-name";
    name.textContent = rule.groupName;
    info.appendChild(name);

    const domains = document.createElement("div");
    domains.className = "rule-domains";
    domains.textContent = rule.domains.join(", ");
    info.appendChild(domains);

    li.appendChild(info);

    const buttons = document.createElement("div");
    buttons.className = "rule-buttons";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => startEdit(rule.id));
    buttons.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteRule(rule.id));
    buttons.appendChild(delBtn);

    li.appendChild(buttons);
    els.list.appendChild(li);
  }
}

function startEdit(id) {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;
  els.ruleId.value = rule.id;
  els.name.value = rule.groupName;
  setColor(rule.color);
  els.domains.value = rule.domains.join(", ");
  els.formTitle.textContent = "Edit group";
  els.saveBtn.textContent = "Update group";
  els.cancelBtn.classList.remove("hidden");
  clearError();
  els.name.focus();
}

async function persistAndRegroup() {
  await saveRules(rules);
  // Ask the background worker to re-scan open tabs.
  chrome.runtime.sendMessage({ type: "regroupAll" });
}

async function deleteRule(id) {
  rules = rules.filter((r) => r.id !== id);
  await persistAndRegroup();
  if (els.ruleId.value === id) resetForm();
  renderRules();
}

async function handleSubmit(event) {
  event.preventDefault();
  clearError();

  const groupName = els.name.value.trim();
  const color = selectedColor;
  const domains = parseDomains(els.domains.value);

  if (!groupName) {
    showError("Please enter a group name.");
    return;
  }
  if (domains.length === 0) {
    showError("Please enter at least one valid domain.");
    return;
  }

  const editingId = els.ruleId.value;

  if (editingId) {
    const rule = rules.find((r) => r.id === editingId);
    if (rule) {
      rule.groupName = groupName;
      rule.color = color;
      rule.domains = domains;
    }
  } else {
    rules.push({ id: generateRuleId(), groupName, color, domains });
  }

  await persistAndRegroup();
  renderRules();
  resetForm();
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function showBanner(text) {
  els.banner.textContent = text;
  els.banner.classList.add("warn");
  els.banner.classList.remove("hidden");
}

function showOrganizeResult(text, isWarn) {
  els.organizeResult.textContent = text;
  els.organizeResult.classList.toggle("warn", !!isWarn);
  els.organizeResult.classList.remove("hidden");
}

async function checkStatus() {
  const resp = await sendMessage({ type: "status" });
  if (!resp.ok || resp.hasTabGroups === false) {
    showBanner(
      "Tab Groups don't appear to be available in this browser. Grouping may not work."
    );
  }
}

async function organizeNow() {
  els.organizeBtn.disabled = true;
  showOrganizeResult("Organizing…", false);
  const resp = await sendMessage({ type: "regroupAll" });
  els.organizeBtn.disabled = false;
  if (!resp.ok) {
    showOrganizeResult("Error: " + (resp.error || "could not reach background"), true);
    return;
  }
  if (resp.hasTabGroups === false) {
    showOrganizeResult("Tab Groups API unavailable in this browser.", true);
    return;
  }
  const n = resp.matched || 0;
  showOrganizeResult(
    n === 0
      ? "No open tabs matched your domains."
      : "Organized " + n + " tab" + (n === 1 ? "" : "s") + ".",
    n === 0
  );
}

async function init() {
  populateColors();
  resetForm();
  rules = await loadRules();
  renderRules();

  els.form.addEventListener("submit", handleSubmit);
  els.cancelBtn.addEventListener("click", resetForm);
  els.organizeBtn.addEventListener("click", organizeNow);

  checkStatus();
}

init();
})();
