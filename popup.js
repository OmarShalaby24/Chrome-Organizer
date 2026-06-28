// Popup logic: manage domain→group rules and trigger re-grouping.

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
};

let rules = [];

function populateColors() {
  for (const color of GROUP_COLORS) {
    const opt = document.createElement("option");
    opt.value = color;
    opt.textContent = color.charAt(0).toUpperCase() + color.slice(1);
    els.color.appendChild(opt);
  }
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
  els.color.value = GROUP_COLORS[0];
  els.domains.value = "";
  els.formTitle.textContent = "Add a group";
  els.saveBtn.textContent = "Save group";
  els.cancelBtn.classList.add("hidden");
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
  els.color.value = rule.color;
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
  const color = els.color.value;
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

async function init() {
  populateColors();
  resetForm();
  rules = await loadRules();
  renderRules();

  els.form.addEventListener("submit", handleSubmit);
  els.cancelBtn.addEventListener("click", resetForm);
}

init();
