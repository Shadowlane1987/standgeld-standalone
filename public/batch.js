"use strict";

const APP_SCOPE = (() => {
  const raw = String(window.STANDGELD_SCOPE || "fernverkehr")
    .trim()
    .toLowerCase();
  return raw === "nahverkehr" ? "nahverkehr" : "fernverkehr";
})();

// Seiten-Modus: "sixfold_only" = strikte Sixfold-Seite ohne Transporeon-Excel
// (nur Zeitfenster-Import erlaubt). Sonst volle Excel-Abgleich-Seite.
const PAGE_MODE = String(window.STANDGELD_MODE || "full")
  .trim()
  .toLowerCase();
const IS_SIXFOLD_ONLY_PAGE = PAGE_MODE === "sixfold_only";

// Die Transporeon-Automation braucht einen echten Browser auf DEINEM PC.
// Läuft die App auf Render (nicht localhost), werden die Automations-Aufrufe
// an den lokalen Abrechnungs-Motor (Standgeld-App starten.cmd) weitergeleitet.
const IS_LOCAL_HOST =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";
const AUTOMATION_BASE = IS_LOCAL_HOST ? "" : "http://localhost:3100";

// Motor-Login pro Bereich getrennt: die "fernverkehr"-Seiten nutzen ein eigenes
// Transporeon-Login, "nahverkehr" ein eigenes. So vermischen sich zwei Logins nie.
const MOTOR_PROFILE = APP_SCOPE;

function automationUnreachableHint() {
  return (
    "Lokaler Abrechnungs-Motor nicht erreichbar. Bitte auf deinem PC die Datei " +
    "'Standgeld-App starten.cmd' per Doppelklick starten und es erneut versuchen."
  );
}

const el = {
  freeMinutes: document.getElementById("freeMinutes"),
  blockMinutes: document.getElementById("blockMinutes"),
  blockRateEur: document.getElementById("blockRateEur"),
  triggerMinutes: document.getElementById("triggerMinutes"),
  lateArrivalGraceEnabled: document.getElementById("lateArrivalGraceEnabled"),
  lateArrivalGraceToggle: document.getElementById("lateArrivalGraceToggle"),
  lateArrivalGraceMinutes: document.getElementById("lateArrivalGraceMinutes"),
  loadBtn: document.getElementById("loadBtn"),
  fileInput: document.getElementById("fileInput"),
  unloadWindowFileInput: document.getElementById("unloadWindowFileInput"),
  unloadWindowStatus: document.getElementById("unloadWindowStatus"),
  deleteUnloadWindowsBtn: document.getElementById("deleteUnloadWindowsBtn"),
  importSelect: document.getElementById("importSelect"),
  importWorkspace: document.getElementById("importWorkspace"),
  activeImportName: document.getElementById("activeImportName"),
  activeImportMeta: document.getElementById("activeImportMeta"),
  refreshImportsBtn: document.getElementById("refreshImportsBtn"),
  uploadUnloadWindowsBtn: document.getElementById("uploadUnloadWindowsBtn"),
  openImportPageBtn: document.getElementById("openImportPageBtn"),
  deleteImportBtn: document.getElementById("deleteImportBtn"),
  uploadBtn: document.getElementById("uploadBtn"),
  sixfoldUrl: document.getElementById("sixfoldUrl"),
  sixfoldToken: document.getElementById("sixfoldToken"),
  selectiveSearchBtn: document.getElementById("selectiveSearchBtn"),
  selectivePanel: document.getElementById("selectivePanel"),
  selectiveResult: document.getElementById("selectiveResult"),
  selectiveTable: document.getElementById("selectiveTable"),
  selectiveStatus: document.getElementById("selectiveStatus"),
  status: document.getElementById("status"),
  resultPanel: document.getElementById("resultPanel"),
  transportCount: document.getElementById("transportCount"),
  stopCount: document.getElementById("stopCount"),
  chargeableCount: document.getElementById("chargeableCount"),
  reviewCount: document.getElementById("reviewCount"),
  gpsUsedCount: document.getElementById("gpsUsedCount"),
  gpsMissingCount: document.getElementById("gpsMissingCount"),
  totalFee: document.getElementById("totalFee"),
  filterMode: document.getElementById("filterMode"),
  sortMode: document.getElementById("sortMode"),
  bookkeepingOnlyMarked: document.getElementById("bookkeepingOnlyMarked"),
  dateFrom: document.getElementById("dateFrom"),
  dateTo: document.getElementById("dateTo"),
  clearDateFilterBtn: document.getElementById("clearDateFilterBtn"),
  batchDateFrom: document.getElementById("batchDateFrom"),
  batchDateTo: document.getElementById("batchDateTo"),
  sixfoldBatchBtn: document.getElementById("sixfoldBatchBtn"),
  bookkeepingExportBtn: document.getElementById("bookkeepingExportBtn"),
  transporeonDryRun: document.getElementById("transporeonDryRun"),
  transporeonStageOnly: document.getElementById("transporeonStageOnly"),
  openTransporeonBtn: document.getElementById("openTransporeonBtn"),
  applyTransporeonBtn: document.getElementById("applyTransporeonBtn"),
  retryFailedTransporeonBtn: document.getElementById(
    "retryFailedTransporeonBtn",
  ),
  resetTransporeonBtn: document.getElementById("resetTransporeonBtn"),
  rows: document.getElementById("rows"),
  tabSettled: document.getElementById("tabSettled"),
  tabAll: document.getElementById("tabAll"),
  settledView: document.getElementById("settledView"),
  allView: document.getElementById("allView"),
  settledRows: document.getElementById("settledRows"),
  settledCount: document.getElementById("settledCount"),
  settledSum: document.getElementById("settledSum"),
  settledExportBtn: document.getElementById("settledExportBtn"),
  stopDetailModal: document.getElementById("stopDetailModal"),
  stopDetailTitle: document.getElementById("stopDetailTitle"),
  stopDetailMeta: document.getElementById("stopDetailMeta"),
  stopDetailRows: document.getElementById("stopDetailRows"),
  closeStopDetailModalBtn: document.getElementById("closeStopDetailModalBtn"),
  closeStopDetailModalBtn2: document.getElementById("closeStopDetailModalBtn2"),
  justificationText: document.getElementById("justificationText"),
  copyJustificationBtn: document.getElementById("copyJustificationBtn"),
};

let currentStops = [];
let activeDetailStop = null;
let currentImportId = "";
let currentImports = [];
let lateArrivalGraceEnabledState = false;
const bookkeepingByKey = new Map();
const BOOKKEEPING_STORAGE_KEY = `standgeld.bookkeeping.${APP_SCOPE}.v1`;
const SIXFOLD_STORAGE_KEY = "standgeld.sixfold.credentials.v1";
const IMPORT_BATCH_STORAGE_KEY = `standgeld.importBatch.${APP_SCOPE}.v1`;
let currentImportBatchIds = [];

const REASON_LABELS = {
  chargeable: "Abrechenbar",
  within_free_time: "Innerhalb Freizeit",
  below_trigger: "Unter Auslöser",
  missing_data: "Daten fehlen",
  implausible_duration: "Unplausibel (Prüfen)",
  spans_next_day: "Folgetag (Prüfen)",
};

const TYPE_LABELS = {
  LOADING: "Laden",
  UNLOADING: "Entladen",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function locationLabel(stop) {
  const raw = String(stop?.booking_location || "").trim();
  return raw ? escapeHtml(raw) : "-";
}

function setStatus(text, type = "info") {
  el.status.textContent = text;
  el.status.style.color =
    type === "error" ? "#b91c1c" : type === "success" ? "#166534" : "#73675a";
}

// Baut aus dem Zuschlagslauf-Ergebnis eine lesbare Liste der Problemfaelle
// (fehlgeschlagene + serverseitig uebersprungene Touren mit Grund).
function buildProblemDetails(data) {
  const problems = [];
  for (const item of data?.processed || []) {
    if (item.status !== "failed" && item.status !== "saved_no_decision")
      continue;
    const station = item.station ? ` (${item.station})` : "";
    problems.push(
      `${item.transport_number || "?"}${station}: ${item.message || "Fehler"}`,
    );
  }
  for (const item of data?.skipped || []) {
    problems.push(
      `${item.transport_number || "?"}: ${item.message || "Uebersprungen"}`,
    );
  }
  if (!problems.length) return "";
  return ` Fehlgeschlagen: ${problems.join(" | ")}`;
}

function formatImportTimestamp(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortImportId(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  const parts = id.split("-");
  return parts[parts.length - 1] || id.slice(-6);
}

function batchSelectionKey(ids) {
  return `batch:${(ids || [])
    .map((id) => String(id).trim())
    .filter(Boolean)
    .join("|")}`;
}

function isBatchSelection(value) {
  return String(value || "").startsWith("batch:");
}

function currentBatchMembers() {
  const available = new Map(
    (currentImports || []).map((item) => [String(item.id || "").trim(), item]),
  );
  return (currentImportBatchIds || [])
    .map((id) => available.get(String(id || "").trim()))
    .filter(Boolean);
}

function buildBatchMeta(items, selectionId) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;

  const importedAt = list
    .map((item) => String(item.imported_at || "").trim())
    .filter(Boolean)
    .sort()
    .at(-1);
  const transportCount = list.reduce(
    (sum, item) => sum + Number(item.transport_count || 0),
    0,
  );
  const fileCount = list.length;
  const unloadDates = list
    .flatMap((item) => [item.unload_date_from, item.unload_date_to])
    .filter(Boolean)
    .sort();

  return {
    id: selectionId || String(list[0]?.id || "").trim(),
    file_name: `Mehrfachimport (${fileCount} Dateien)`,
    imported_at: importedAt || list[0]?.imported_at || null,
    transport_count: transportCount,
    unload_date_from: unloadDates[0] || null,
    unload_date_to: unloadDates[unloadDates.length - 1] || null,
    batch_ids: list.map((item) => String(item.id || "").trim()).filter(Boolean),
    batch_count: fileCount,
  };
}

function batchOptionLabel(meta) {
  if (!meta) return "Mehrfachimport";
  const importedAt = formatImportTimestamp(meta.imported_at);
  const range =
    meta.unload_date_from && meta.unload_date_to
      ? ` · ${meta.unload_date_from} bis ${meta.unload_date_to}`
      : "";
  const importedAtText = importedAt ? ` · ${importedAt}` : "";
  return `${meta.file_name} (${meta.transport_count || 0})${range}${importedAtText}`;
}

function importIdFromUrl() {
  const url = new URL(window.location.href);
  return String(url.searchParams.get("import") || "").trim();
}

function setImportIdInUrl(importId, replace = true) {
  const url = new URL(window.location.href);
  if (importId) url.searchParams.set("import", importId);
  else url.searchParams.delete("import");
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

function currentImportMeta() {
  const batchMembers = currentBatchMembers();
  if (currentImportBatchIds.length > 1 && batchMembers.length > 1) {
    return buildBatchMeta(
      batchMembers,
      batchSelectionKey(currentImportBatchIds),
    );
  }
  return currentImports.find((item) => item.id === currentImportId) || null;
}

function syncImportWorkspace() {
  const hasImport = Boolean(currentImportId);
  if (el.loadBtn) el.loadBtn.disabled = !hasImport;
  if (el.openImportPageBtn) el.openImportPageBtn.disabled = !hasImport;
  if (el.deleteImportBtn) el.deleteImportBtn.disabled = !hasImport;

  if (!el.importWorkspace || !el.activeImportName || !el.activeImportMeta) {
    return;
  }

  if (!hasImport) {
    el.importWorkspace.hidden = true;
    el.activeImportName.textContent = "-";
    el.activeImportMeta.textContent = "";
    return;
  }

  const meta = currentImportMeta();
  const fileName = meta?.file_name || currentImportId;
  const importedAt = formatImportTimestamp(meta?.imported_at);
  const transportCount = Number(meta?.transport_count || 0);
  const range =
    meta?.unload_date_from && meta?.unload_date_to
      ? `${meta.unload_date_from} bis ${meta.unload_date_to}`
      : "kein Datumsbereich";

  el.importWorkspace.hidden = false;
  el.activeImportName.textContent = fileName;
  el.activeImportMeta.textContent =
    ` · ${transportCount} Transporte · ${range}` +
    (importedAt ? ` · hochgeladen: ${importedAt}` : "");
}

function clearResults() {
  currentStops = [];
  if (el.rows) el.rows.innerHTML = "";
  if (el.resultPanel) el.resultPanel.hidden = true;
  activeDetailStop = null;
}

function readBookkeepingStorage() {
  try {
    const raw = window.localStorage.getItem(BOOKKEEPING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeBookkeepingStorage(storage) {
  try {
    window.localStorage.setItem(
      BOOKKEEPING_STORAGE_KEY,
      JSON.stringify(storage || {}),
    );
  } catch (_error) {
    // ignore storage write errors
  }
}

function readSixfoldStorage() {
  try {
    const raw = window.localStorage.getItem(SIXFOLD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function readRuleStorage() {
  try {
    const raw = window.localStorage.getItem("standgeld.batch.rules.v1");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function readImportBatchStorage() {
  try {
    const raw = window.localStorage.getItem(IMPORT_BATCH_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function writeImportBatchStorage(ids) {
  try {
    window.localStorage.setItem(
      IMPORT_BATCH_STORAGE_KEY,
      JSON.stringify(Array.isArray(ids) ? ids : []),
    );
  } catch (_error) {
    // ignore storage write errors
  }
}

function setCurrentImportBatch(ids) {
  const uniqueIds = [
    ...new Set((ids || []).map((id) => String(id).trim())),
  ].filter(Boolean);
  currentImportBatchIds = uniqueIds;
  writeImportBatchStorage(uniqueIds);
}

function activeImportIds() {
  const current = String(
    currentImportId || el.importSelect?.value || "",
  ).trim();
  if (!currentImports.length) return current ? [current] : [];

  const available = new Set(
    currentImports.map((item) => String(item.id || "").trim()),
  );
  const batch = (currentImportBatchIds || []).filter((id) => available.has(id));

  // Batch nur dann nutzen, wenn der aktuell ausgewaehlte Import Teil davon ist.
  if (batch.length > 1 && current && batch.includes(current)) return batch;
  return current ? [current] : [];
}

function writeRuleStorage(value) {
  try {
    window.localStorage.setItem(
      "standgeld.batch.rules.v1",
      JSON.stringify(value),
    );
  } catch (_error) {
    // ignore storage write errors
  }
}

function persistRuleSettings() {
  writeRuleStorage({
    lateArrivalGraceEnabled: lateArrivalGraceEnabledState,
    lateArrivalGraceMinutes: Number(el.lateArrivalGraceMinutes?.value || 30),
  });
}

function syncLateArrivalGraceToggle() {
  if (!el.lateArrivalGraceToggle) return;
  const enabled = lateArrivalGraceEnabledState;
  el.lateArrivalGraceToggle.textContent = enabled
    ? "Verspätungsregel: Ein"
    : "Verspätungsregel: Aus";
  el.lateArrivalGraceToggle.setAttribute(
    "aria-pressed",
    enabled ? "true" : "false",
  );
}

async function persistRuleSettingsAndReload() {
  persistRuleSettings();
  syncLateArrivalGraceToggle();
  if (currentImportId) {
    try {
      await load(true);
    } catch (_error) {
      // load() setzt den Status selbst
    }
  }
}

function applyResult(data) {
  const summary = data?.summary || {};
  if (summary.total_fee_eur != null) {
    el.totalFee.textContent = summary.total_fee_display || "0,00 €";
  }
  if (typeof data?.cached === "boolean") {
    setStatus(
      data.cached
        ? "Verwendete gecachte Abrechnung."
        : "Frische Abrechnung berechnet.",
      data.cached ? "info" : "success",
    );
  }
  render();
}

function restoreRuleSettings() {
  const stored = readRuleStorage();
  lateArrivalGraceEnabledState = Boolean(stored.lateArrivalGraceEnabled);
  if (el.lateArrivalGraceMinutes && stored.lateArrivalGraceMinutes != null) {
    el.lateArrivalGraceMinutes.value = String(stored.lateArrivalGraceMinutes);
  }
  syncLateArrivalGraceToggle();
}

function writeSixfoldStorage(value) {
  try {
    window.localStorage.setItem(SIXFOLD_STORAGE_KEY, JSON.stringify(value));
  } catch (_error) {
    // ignore storage write errors
  }
}

function persistSixfoldCredentials() {
  writeSixfoldStorage({
    url: String(el.sixfoldUrl?.value || "").trim(),
    token: String(el.sixfoldToken?.value || "").trim(),
  });
}

function restoreSixfoldCredentials() {
  const stored = readSixfoldStorage();
  if (el.sixfoldUrl && stored.url) {
    el.sixfoldUrl.value = String(stored.url);
  }
  if (el.sixfoldToken && stored.token) {
    el.sixfoldToken.value = String(stored.token);
  }
}

function loadBookkeepingForImport(importId) {
  bookkeepingByKey.clear();
  const id = String(importId || "").trim();
  if (!id) return;

  const storage = readBookkeepingStorage();
  const entries = storage[id];
  if (!entries || typeof entries !== "object") return;

  for (const [key, value] of Object.entries(entries)) {
    bookkeepingByKey.set(key, {
      billed: Boolean(value && value.billed),
      submitted: Boolean(value && value.submitted),
      failed: Boolean(value && value.failed),
      existing: Boolean(value && value.existing),
      manual: Boolean(value && value.manual),
    });
  }
}

function persistBookkeepingForCurrentImport() {
  const id = String(currentImportId || "").trim();
  if (!id) return;

  const storage = readBookkeepingStorage();
  const snapshot = {};
  for (const [key, entry] of bookkeepingByKey.entries()) {
    snapshot[key] = {
      billed: Boolean(entry && entry.billed),
      submitted: Boolean(entry && entry.submitted),
      failed: Boolean(entry && entry.failed),
      existing: Boolean(entry && entry.existing),
      manual: Boolean(entry && entry.manual),
    };
  }
  storage[id] = snapshot;
  writeBookkeepingStorage(storage);
}

function removeBookkeepingForImport(importId) {
  const id = String(importId || "").trim();
  if (!id) return;

  const storage = readBookkeepingStorage();
  if (!Object.prototype.hasOwnProperty.call(storage, id)) return;
  delete storage[id];
  writeBookkeepingStorage(storage);
}

function euro(value) {
  return Number(value || 0).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

function minutesToHours(value) {
  if (value === null || value === undefined) return "-";
  const total = Math.max(0, Math.round(Number(value)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, "0")} h`;
}

function isoToLocal(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTimeForJustification(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return "-";

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) {
    const local = direct.toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return local.replace(", ", " / ");
  }

  const withYear = text.match(/^(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})$/);
  if (withYear) return `${withYear[1].slice(0, 6)} / ${withYear[2]}`;

  const shortDate = text.match(/^(\d{2}\.\d{2})\.?[,]?\s*(\d{2}:\d{2})$/);
  if (shortDate) return `${shortDate[1]}. / ${shortDate[2]}`;

  return text;
}

function standingMinutesFromIso(arrivalIso, departureIso) {
  if (!arrivalIso || !departureIso) return null;
  const a = Date.parse(arrivalIso);
  const d = Date.parse(departureIso);
  if (Number.isNaN(a) || Number.isNaN(d)) return null;
  return (d - a) / 60000;
}

function detailCell(text) {
  return text || "-";
}

function normalizeDetailValue(value) {
  return String(value || "").trim();
}

function isSameTimestamp(left, right) {
  const normalizedLeft = String(left || "").trim();
  const normalizedRight = String(right || "").trim();
  return (
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight
  );
}

function sourceTone(source) {
  return String(source || "XP").toUpperCase() === "GPS"
    ? "time-chip-gps"
    : "time-chip-xp";
}

function timeContext(stop) {
  const hasWindow = Boolean(stop.window_start || stop.window_local);
  const windowClass = stop.unload_window_fallback_applied
    ? "time-chip-excel"
    : "time-chip-neutral";
  const windowHint = stop.unload_window_fallback_applied ? "Excel" : "Fenster";

  if (!hasWindow) {
    return {
      windowClass: "time-chip-neutral",
      startClass: "time-chip-neutral",
      windowHint: "Fenster",
      startHint: "Start",
    };
  }

  // Verspaetung -> Zaehlbeginn rot markieren (auf einen Blick erkennbar).
  if (stop.arrived_late || stop.rebooking_suspected) {
    let startHint = "verspätet";
    if (stop.rebooking_suspected) startHint = "Prüffall GPS-Start";
    else if (stop.late_arrival_grace_applied) startHint = "3h-Regel";
    return {
      windowClass,
      startClass: "time-chip-alert",
      windowHint,
      startHint,
    };
  }

  // Puenktlich -> Zaehlbeginn gleiche Farbe wie das Zeitfenster.
  return {
    windowClass,
    startClass: windowClass,
    windowHint,
    startHint: "pünktlich",
  };
}

function timeCellHtml(value, toneClass, hint) {
  const text = value || "-";
  const chip = toneClass ? ` time-chip ${toneClass}` : "";
  const suffix =
    hint && text !== "-" ? `<span class="time-hint">${hint}</span>` : "";
  return `<span class="time-stack"><span class="${chip.trim()}">${text}</span>${suffix}</span>`;
}

function detailRowHtml(label, xpValue, gpsValue, usedValue) {
  const xp = detailCell(xpValue);
  const gps = detailCell(gpsValue);
  const used = detailCell(usedValue);

  const normalizedXp = normalizeDetailValue(xp);
  const normalizedGps = normalizeDetailValue(gps);
  const normalizedUsed = normalizeDetailValue(used);

  const xpWins =
    normalizedUsed !== "-" &&
    normalizedXp !== "-" &&
    normalizedXp === normalizedUsed;
  const gpsWins =
    normalizedUsed !== "-" &&
    normalizedGps !== "-" &&
    normalizedGps === normalizedUsed;

  const xpClass = xpWins ? "detail-win detail-win-xp" : "";
  const gpsClass = gpsWins ? "detail-win detail-win-gps" : "";

  return `
    <tr>
      <td>${label}</td>
      <td class="${xpClass}">${xp}</td>
      <td class="${gpsClass}">${gps}</td>
      <td class="detail-used">${used}</td>
    </tr>
  `;
}

function fallbackStatusRowHtml(stop) {
  if (!stop || stop.stop_type !== "UNLOADING") return "";

  const replaced = Boolean(stop.unload_window_fallback_applied);
  const hasWindow = String(stop.window_local || "").trim().length > 0;

  let statusClass = "fallback-status-neutral";
  let statusText = "Nicht ersetzt";

  if (replaced) {
    statusClass = "fallback-status-replaced";
    statusText = "Ersetzt";
  } else if (!hasWindow) {
    statusClass = "fallback-status-missing";
    statusText = "Fehlt weiterhin";
  }

  return `
    <tr>
      <td>Entladezeitfenster</td>
      <td>-</td>
      <td>-</td>
      <td class="detail-used"><span class="fallback-status ${statusClass}">${statusText}</span></td>
    </tr>
  `;
}

function buildWindowStatus(stop) {
  const hasWindow = Boolean(String(stop?.window_local || "").trim());
  if (!hasWindow) {
    return {
      className: "detail-window-missing",
      text: "Kein Zeitfenster",
    };
  }

  if (stop?.arrived_late) {
    return {
      className: "detail-window-late",
      text: stop.late_arrival_grace_applied
        ? "Verspätet · 3h-Regel"
        : "Verspätet",
    };
  }

  return {
    className: "detail-window-hit",
    text: "Pünktlich",
  };
}

function detailWindowRowHtml(windowValue, status) {
  return `
    <tr>
      <td>Zeitfenster</td>
      <td>${detailCell(windowValue)}</td>
      <td>-</td>
      <td class="detail-used"><span class="detail-window-badge ${status.className}">${status.text}</span></td>
    </tr>
  `;
}

function detailTotalRowHtml(amount) {
  return `
    <tr class="detail-total-row">
      <td>Abrechenbare Summe</td>
      <td>-</td>
      <td>-</td>
      <td class="detail-used">${amount}</td>
    </tr>
  `;
}

function openStopDetailModal(stop) {
  if (!el.stopDetailModal || !stop) return;
  activeDetailStop = stop;

  const typeLabel = TYPE_LABELS[stop.stop_type] || stop.stop_type || "-";
  el.stopDetailTitle.textContent = `${stop.transport_number || "-"} · ${typeLabel}`;

  const source = sourceLabel(stop);
  const kfz = plateCheckLabel(stop);
  const context = timeContext(stop);
  const usedStanding = minutesToHours(
    standingMinutesFromIso(stop.arrival_time_used, stop.departure_time_used) ??
      stop.counted_standing_minutes,
  );
  const countedStanding = minutesToHours(stop.counted_standing_minutes);
  const overFreeStanding = minutesToHours(stop.minutes_over_free);
  const freeWindow = minutesToHours(stop.free_minutes || 120);
  const windowLocal = formatDateTimeForJustification(
    stop.window_local || stop.window_start,
  );
  const rebookingNote = stop.rebooking_suspected
    ? " · ⚠ Umbuchung/Pause erkannt: gezählt ab GPS-Ankunft (Prüffall)"
    : "";
  const totalAmount = euro(stop.fee_eur);
  const arrivalUsed = formatDateTimeForJustification(stop.arrival_time_used);
  const departureUsed = formatDateTimeForJustification(
    stop.departure_time_used,
  );
  const arrivalSrc = stop.arrival_source || "XP";
  const departureSrc = stop.departure_source || "XP";
  const summaryLine =
    `Quelle: ${source}` + (kfz !== "-" ? ` · KFZ: ${kfz}` : "") + rebookingNote;
  const windowStatus = buildWindowStatus(stop);

  if (el.stopDetailMeta) {
    el.stopDetailMeta.textContent = "";
    el.stopDetailMeta.hidden = true;
  }

  const xpArrival = formatDateTimeForJustification(stop.xp_arrival_time);
  const xpDeparture = formatDateTimeForJustification(stop.xp_departure_time);
  const gpsArrival = formatDateTimeForJustification(stop.gps_arrival_time);
  const gpsDeparture = formatDateTimeForJustification(stop.gps_departure_time);
  const usedDeparture = departureUsed;
  const usedCountStart = formatDateTimeForJustification(stop.count_start);
  const usedCountStartCell =
    usedCountStart === "-"
      ? "-"
      : `<span class="time-chip ${stop.arrived_late ? "time-chip-alert" : "time-chip-match"}">${usedCountStart}</span>`;

  const xpStanding = minutesToHours(
    standingMinutesFromIso(stop.xp_arrival_time, stop.xp_departure_time),
  );
  const gpsStanding = minutesToHours(
    standingMinutesFromIso(stop.gps_arrival_time, stop.gps_departure_time),
  );

  el.stopDetailRows.innerHTML =
    detailWindowRowHtml(windowLocal, windowStatus) +
    detailRowHtml("Ankunft", xpArrival, gpsArrival, usedCountStartCell) +
    detailRowHtml("Abfahrt", xpDeparture, gpsDeparture, usedDeparture) +
    detailRowHtml("Standzeit (Ist)", xpStanding, gpsStanding, usedStanding) +
    detailRowHtml(
      "Standzeit ab Zählbeginn",
      "-",
      "-",
      `${countedStanding}${stop.late_arrival_grace_applied ? " · 3h-Regel" : ""}`,
    ) +
    detailRowHtml("Freigrenze", "-", "-", freeWindow) +
    detailRowHtml("Über Frei", "-", "-", overFreeStanding) +
    fallbackStatusRowHtml(stop) +
    detailTotalRowHtml(totalAmount);

  el.stopDetailModal.hidden = false;
  if (el.justificationText) {
    el.justificationText.value = buildJustificationText(stop);
  }
}

function closeStopDetailModal() {
  if (!el.stopDetailModal) return;
  el.stopDetailModal.hidden = true;
}

function selectStop(stop) {
  if (!stop) return;
  activeDetailStop = stop;
  render();

  if (el.rows) {
    const selectedKey = stopKey(stop);
    const selectedRow = Array.from(
      el.rows.querySelectorAll("tr[data-stop-key]"),
    ).find((row) => row.dataset.stopKey === selectedKey);
    if (selectedRow && typeof selectedRow.scrollIntoView === "function") {
      selectedRow.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  openStopDetailModal(stop);
}

function billedMinutes(stop) {
  if (!stop || !stop.chargeable) return 0;
  return Math.max(0, Math.round(Number(stop.minutes_over_free || 0)));
}

function buildJustificationText(stop) {
  if (!stop) return "";

  const windowLocal = formatDateTimeForJustification(
    stop.window_local || stop.window_start,
  );
  const arrivalUsed = formatDateTimeForJustification(stop.arrival_time_used);
  const departureUsed = formatDateTimeForJustification(
    stop.departure_time_used,
  );
  const countedStanding = minutesToHours(stop.counted_standing_minutes);
  const billableStanding = minutesToHours(stop.minutes_over_free);

  return [
    `Zeitfenster: ${windowLocal}`,
    `Ankunft: ${arrivalUsed}`,
    `Abfahrt: ${departureUsed}`,
    `Standzeit: ${countedStanding}`,
    `Abzurechnende Standzeit: ${billableStanding}`,
  ].join("\n");
}

function usedBoundaryLabel(iso, source) {
  const local = formatDateTimeForJustification(iso);
  if (local === "-") return "-";
  return `${local} ${source || "XP"}`;
}

function copyJustificationText() {
  const text = String(el.justificationText?.value || "").trim();
  if (!text) return;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      setStatus("Begründung in Zwischenablage kopiert.", "success");
    })
    .catch(() => {
      if (el.justificationText) {
        el.justificationText.focus();
        el.justificationText.select();
        document.execCommand("copy");
        setStatus("Begründung in Zwischenablage kopiert.", "success");
      }
    });
}

function stopDate(stop) {
  // Lokales Kalenderdatum des Stopps (YYYY-MM-DD) aus den vorhandenen Zeitfeldern.
  const raw = String(
    stop.window_local ||
      stop.arrival_local ||
      stop.count_start ||
      stop.window_start ||
      "",
  ).trim();
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function dateInRange(stop) {
  const from = el.dateFrom && el.dateFrom.value ? el.dateFrom.value : "";
  const to = el.dateTo && el.dateTo.value ? el.dateTo.value : "";
  if (!from && !to) return true;
  const d = stopDate(stop);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function filteredStops() {
  // Sixfold-Seite hat keinen Filter: dort werden direkt nur abrechenbare
  // Positionen gezeigt.
  const mode = el.filterMode
    ? el.filterMode.value
    : IS_SIXFOLD_ONLY_PAGE
      ? "chargeable"
      : "all";
  let list = currentStops;
  if (mode === "chargeable") list = list.filter((s) => s.fee_eur > 0);
  else if (mode === "review") list = list.filter((s) => s.needs_review);
  else if (mode === "gpsMissing") list = list.filter((s) => s.gps_missing);
  else if (mode === "unloadFallback")
    list = list.filter(
      (s) => s.unload_window_fallback_applied === true && s.fee_eur > 0,
    );
  // Fake-Kennzeichen (Handynummer, XP-Zeiten) IMMER ans Ende der Liste.
  const base = list
    .filter(dateInRange)
    .sort((a, b) => (a.plate_fake ? 1 : 0) - (b.plate_fake ? 1 : 0));

  // Statussortierung: 1. puenktlich (+abrechenbar zuerst), 2. zu spaet aber
  // innerhalb 30 min, 3. 3h-Faelle. Fake-Kennzeichen bleiben ganz am Ende.
  const sortValue = el.sortMode ? el.sortMode.value : "status";
  if (sortValue !== "status") return base;
  return base.sort((a, b) => {
    const fakeDiff = (a.plate_fake ? 1 : 0) - (b.plate_fake ? 1 : 0);
    if (fakeDiff !== 0) return fakeDiff;
    const rankDiff = statusRank(a) - statusRank(b);
    if (rankDiff !== 0) return rankDiff;
    return Number(b.fee_eur || 0) - Number(a.fee_eur || 0);
  });
}

function statusRank(stop) {
  let group = 0; // puenktlich
  if (stop?.late_arrival_grace_applied)
    group = 2; // 3h-Fall
  else if (stop?.arrived_late) group = 1; // zu spaet, innerhalb 30 min
  const chargeable = Number(stop?.fee_eur || 0) > 0 ? 0 : 1;
  return group * 10 + chargeable;
}

function sourceLabel(stop) {
  // GPS gar nicht abgefragt -> neutral "XP" (nicht "kein GPS").
  if (!stop.gps_checked) return "XP";
  if (stop.gps_missing) return "XP (kein GPS)";
  const a = stop.arrival_source || "XP";
  const d = stop.departure_source || "XP";
  if (a === d) return a === "GPS" ? "GPS" : "XP";
  return `An:${a} / Ab:${d}`;
}

function sourceClass(stop) {
  if (!stop.gps_checked) return "src-neutral";
  if (stop.gps_missing) return "src-nogps";
  const src = sourceLabel(stop);
  return src === "GPS" ? "src-gps" : "src-mixed";
}

function plateCheckLabel(stop) {
  const excelPlate = (stop.excel_license_plate || "").trim();
  const gpsPlate = (stop.gps_license_plate || "").trim();
  // Fake-Kennzeichen (Handynummer): klar markieren, abgerechnet ueber XP-Zeiten.
  if (stop.plate_fake) return `⚠ Fake (${gpsPlate || "?"})`;
  // Reine Sixfold-Touren haben kein Excel-Kennzeichen zum Abgleichen -> GPS-Kennzeichen direkt zeigen.
  if (stop.origin === "sixfold_only") return gpsPlate || excelPlate || "-";
  if (!stop.gps_checked || !stop.gps_plate_match) return "-";
  return excelPlate || gpsPlate || "-";
}

function stopKey(stop) {
  return [
    String(stop.transport_number || "").trim(),
    String(stop.stop_type || "").trim(),
    String(stop.window_local || "").trim(),
    String(stop.arrival_time_used || "").trim(),
    String(stop.departure_time_used || "").trim(),
  ].join("|");
}

function getBookkeepingEntry(stop) {
  const key = stopKey(stop);
  if (!bookkeepingByKey.has(key)) {
    bookkeepingByKey.set(key, {
      billed: false,
      submitted: false,
      failed: false,
      existing: false,
      manual: false,
    });
  }
  return bookkeepingByKey.get(key);
}

function ensureBookkeepingEntries(stops) {
  for (const stop of stops || []) getBookkeepingEntry(stop);
}

function buildBookkeepingRows(onlyMarked) {
  const rows = [];
  for (const stop of currentStops || []) {
    const entry = getBookkeepingEntry(stop);
    if (onlyMarked && !entry.billed) continue;

    rows.push({
      transport_number: String(stop.transport_number || "").trim(),
      amount_eur: Number(stop.fee_eur || 0),
      surcharge_id: "",
    });
  }
  return rows;
}

function buildTransporeonSurchargeRows(onlyFailed = false) {
  const rows = [];
  for (const stop of currentStops || []) {
    if (!stop || Number(stop.fee_eur || 0) <= 0) continue;
    if (Boolean(stop.needs_review)) continue;

    const entry = getBookkeepingEntry(stop);
    if (!entry.billed) continue;
    // Bereits erfolgreich abgerechnete Zeilen in einem normalen Lauf NICHT
    // erneut senden (sonst kaemen sie als "already_exists" zurueck und wuerden
    // faelschlich zurueckgestuft).
    if (!onlyFailed && entry.submitted && !entry.failed) continue;
    if (onlyFailed && !(entry.failed && !entry.submitted)) continue;

    rows.push({
      transport_number: String(stop.transport_number || "").trim(),
      stop_type: String(stop.stop_type || "")
        .trim()
        .toUpperCase(),
      amount_eur: Number(stop.fee_eur || 0),
      description: buildJustificationText(stop),
      stop_key: stopKey(stop),
    });
  }
  return rows;
}

async function openTransporeonSession() {
  if (el.openTransporeonBtn) el.openTransporeonBtn.disabled = true;
  setStatus("Öffne Automations-Fenster für Transporeon …");
  try {
    const res = await fetch(`${AUTOMATION_BASE}/api/transporeon/session/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: MOTOR_PROFILE }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (data.list_ready) {
      setStatus(
        `Automations-Fenster bereit: ${data.row_count || 0} Transportzeilen erkannt.`,
        "success",
      );
    } else {
      setStatus(
        "Automations-Fenster geöffnet. Bitte in DIESEM Fenster bei Transporeon einloggen und 'Zugewiesene Transporte' öffnen, dann erneut prüfen.",
        "info",
      );
    }
  } catch (error) {
    const msg =
      error instanceof TypeError && !IS_LOCAL_HOST
        ? automationUnreachableHint()
        : error.message || "Automations-Fenster konnte nicht geöffnet werden.";
    setStatus(msg, "error");
  } finally {
    if (el.openTransporeonBtn) el.openTransporeonBtn.disabled = false;
  }
}

async function resetTransporeonSession() {
  if (
    !window.confirm(
      "Motor abmelden? Das gespeicherte Transporeon-Login dieses Bereichs wird gelöscht – beim nächsten Öffnen musst du dich neu einloggen.",
    )
  ) {
    return;
  }
  if (el.resetTransporeonBtn) el.resetTransporeonBtn.disabled = true;
  setStatus("Melde Motor ab …");
  try {
    const res = await fetch(
      `${AUTOMATION_BASE}/api/transporeon/session/reset`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: MOTOR_PROFILE }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setStatus(
      "Motor abgemeldet. Beim nächsten Öffnen bitte neu bei Transporeon einloggen.",
      "success",
    );
  } catch (error) {
    const msg =
      error instanceof TypeError && !IS_LOCAL_HOST
        ? automationUnreachableHint()
        : error.message || "Motor konnte nicht abgemeldet werden.";
    setStatus(msg, "error");
  } finally {
    if (el.resetTransporeonBtn) el.resetTransporeonBtn.disabled = false;
  }
}

async function applyTransporeonSurcharges(onlyFailed = false) {
  const rows = buildTransporeonSurchargeRows(onlyFailed);
  if (!rows.length) {
    setStatus(
      onlyFailed
        ? "Keine fehlgeschlagenen Positionen zum erneuten Beantragen vorhanden."
        : "Keine markierten Positionen für Transporeon vorhanden.",
      "error",
    );
    return;
  }

  const dryRun = Boolean(el.transporeonDryRun?.checked);
  const stageOnly = !dryRun && Boolean(el.transporeonStageOnly?.checked);
  const confirmText = dryRun
    ? `Trockenlauf für ${rows.length} Positionen starten?`
    : stageOnly
      ? `${rows.length} Zuschläge in Transporeon EINTRAGEN und speichern, aber NICHT absenden (zum Prüfen)?`
      : onlyFailed
        ? `${rows.length} fehlgeschlagene Zuschläge erneut in Transporeon beantragen?`
        : `Automatisch ${rows.length} Zuschläge in Transporeon anlegen und Entscheidung einholen?`;
  if (!window.confirm(confirmText)) return;

  if (el.applyTransporeonBtn) el.applyTransporeonBtn.disabled = true;
  if (el.retryFailedTransporeonBtn)
    el.retryFailedTransporeonBtn.disabled = true;
  setStatus(
    dryRun
      ? `Prüfe ${rows.length} markierte Positionen per Transporeon-Suche …`
      : stageOnly
        ? `Trage ${rows.length} markierte Zuschläge ein (ohne Absenden) …`
        : `Beantrage ${rows.length} markierte Zuschläge in Transporeon …`,
  );

  try {
    const res = await fetch(
      `${AUTOMATION_BASE}/api/transporeon/surcharges/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: MOTOR_PROFILE,
          dryRun,
          submitDecision: !stageOnly,
          keepBrowserOpen: true,
          items: rows,
        }),
      },
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const doneTransports = [];
    if (!dryRun && Array.isArray(data.processed)) {
      const successKeys = new Set(
        data.processed
          .filter((item) => item.status === "applied")
          .map((item) => String(item.stop_key || "").trim())
          .filter(Boolean),
      );
      // Bereits vorhandene Standzeit-Zeilen: eigener Zustand. Diese Touren
      // wurden NICHT von diesem Lauf abgerechnet -> als Problem markieren,
      // aus "Abgerechnet" und der Excel herausnehmen (billed=false).
      const alreadyExistsKeys = new Set(
        data.processed
          .filter((item) => item.status === "already_exists")
          .map((item) => String(item.stop_key || "").trim())
          .filter(Boolean),
      );
      const failedKeys = new Set(
        [
          ...data.processed.filter(
            (item) =>
              item.status === "failed" || item.status === "saved_no_decision",
          ),
          ...(Array.isArray(data.skipped) ? data.skipped : []),
        ]
          .map((item) => String(item.stop_key || "").trim())
          .filter(Boolean),
      );
      if (successKeys.size || alreadyExistsKeys.size || failedKeys.size) {
        for (const stop of currentStops || []) {
          const key = stopKey(stop);
          if (successKeys.has(key)) {
            const entry = getBookkeepingEntry(stop);
            entry.billed = true;
            entry.submitted = true;
            entry.failed = false;
            entry.existing = false;
            doneTransports.push(String(stop.transport_number || "").trim());
          } else if (alreadyExistsKeys.has(key)) {
            // Eigener Status: Standzeit-Zeile existiert schon -> NICHT in Excel,
            // nicht gruen, sondern klar als "Bereits vorhanden" markieren.
            const entry = getBookkeepingEntry(stop);
            entry.billed = false;
            entry.submitted = false;
            entry.failed = false;
            entry.existing = true;
          } else if (failedKeys.has(key)) {
            const entry = getBookkeepingEntry(stop);
            entry.submitted = false;
            entry.failed = true;
            entry.existing = false;
          }
        }
        persistBookkeepingForCurrentImport();
        render();
      }
    }

    const success = Number(data.summary?.success_count || 0);
    const alreadyExists = Number(data.summary?.already_exists_count || 0);
    const savedNoDecision = Number(data.summary?.saved_no_decision_count || 0);
    const staged = Number(data.summary?.staged_count || 0);
    const failure = Number(data.summary?.failure_count || 0);
    if (dryRun) {
      setStatus(
        `Trockenlauf fertig: ${success} bereit, ${failure + alreadyExists} nicht gefunden/fehlerhaft.`,
        failure + alreadyExists > 0 ? "info" : "success",
      );
    } else if (stageOnly) {
      const stagedText = staged
        ? ` ${staged} eingetragen (noch NICHT abgesendet – bitte in Transporeon prüfen und selbst absenden).`
        : "";
      const existsText = alreadyExists
        ? ` ${alreadyExists} bereits vorhanden (übersprungen).`
        : "";
      const failedDetails = buildProblemDetails(data);
      setStatus(
        `Eintragen ohne Absenden fertig: ${staged} eingetragen, ${failure} fehlgeschlagen.${existsText}${stagedText}${failedDetails}`,
        failure + alreadyExists > 0 ? "info" : "success",
      );
    } else {
      const doneText = doneTransports.length
        ? ` Abgerechnet: ${doneTransports.join(", ")}.`
        : "";
      const existsText = alreadyExists
        ? ` ${alreadyExists} bereits vorhanden (übersprungen).`
        : "";
      const noDecisionText = savedNoDecision
        ? ` ${savedNoDecision} gespeichert OHNE Entscheidung (bitte manuell prüfen).`
        : "";
      const failedDetails = buildProblemDetails(data);
      setStatus(
        `Zuschlagslauf fertig: ${success} erfolgreich, ${failure} fehlgeschlagen.${existsText}${noDecisionText}${doneText}${failedDetails}`,
        failure + alreadyExists > 0 ? "info" : "success",
      );
    }
  } catch (error) {
    const msg =
      error instanceof TypeError && !IS_LOCAL_HOST
        ? automationUnreachableHint()
        : error.message || "Zuschlagslauf konnte nicht gestartet werden.";
    setStatus(msg, "error");
  } finally {
    if (el.applyTransporeonBtn) el.applyTransporeonBtn.disabled = false;
    if (el.retryFailedTransporeonBtn)
      el.retryFailedTransporeonBtn.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportBookkeeping() {
  const onlyMarked = Boolean(el.bookkeepingOnlyMarked?.checked);
  const rows = buildBookkeepingRows(onlyMarked);
  if (!rows.length) {
    setStatus("Keine Positionen für den Buchungs-Export ausgewählt.", "error");
    return;
  }

  if (el.bookkeepingExportBtn) el.bookkeepingExportBtn.disabled = true;
  setStatus("Erstelle Buchungs-Excel …");

  try {
    const res = await fetch("/api/billing/bookkeeping-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });

    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        err = data.error || err;
      } catch {
        // ignore JSON parse error
      }
      throw new Error(err);
    }

    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `standgeld_buchungsjournal_${stamp}.xlsx`);
    setStatus("Buchungs-Excel wurde exportiert.", "success");
  } catch (error) {
    setStatus(error.message || "Buchungs-Export fehlgeschlagen.", "error");
  } finally {
    if (el.bookkeepingExportBtn) el.bookkeepingExportBtn.disabled = false;
  }
}

function render() {
  const stops = filteredStops();
  el.rows.innerHTML = "";
  const selectedKey = activeDetailStop ? stopKey(activeDetailStop) : "";

  for (const stop of stops) {
    const tr = document.createElement("tr");
    const stopKeyValue = stopKey(stop);
    tr.dataset.stopKey = stopKeyValue;
    tr.className = "result-row";
    if (stop.needs_review) tr.classList.add("review-row");
    else if (stop.fee_eur > 0) tr.classList.add("chargeable-row");
    if (stop.unload_window_fallback_applied) tr.classList.add("fallback-row");
    if (stop.plate_fake) tr.classList.add("fake-plate-row");
    if (selectedKey && stopKeyValue === selectedKey) {
      tr.classList.add("selected-row");
      tr.setAttribute("aria-current", "true");
    }
    tr.tabIndex = 0;

    const statusLabel = stop.needs_review
      ? stop.spans_next_day
        ? "Prüfen · Folgetag"
        : "Prüfen"
      : REASON_LABELS[stop.reason] || stop.reason || "-";

    const src = sourceLabel(stop);
    const srcClass = sourceClass(stop);
    const context = timeContext(stop);

    const bk = getBookkeepingEntry(stop);
    const checkedAttr = bk.billed ? "checked" : "";
    if (bk.submitted) tr.classList.add("submitted-row");
    else if (bk.existing) tr.classList.add("existing-row");
    else if (bk.failed) tr.classList.add("failed-row");
    const statusBadge = bk.submitted
      ? `<span class="tp-done">✓ Abgerechnet${bk.manual ? " (manuell)" : ""}</span>`
      : bk.existing
        ? '<span class="tp-existing">● Bereits vorhanden</span>'
        : bk.failed
          ? '<span class="tp-failed">✗ Fehlgeschlagen</span>'
          : '<span class="tp-open">—</span>';
    // Manuelle Steuerung (Nutzer 2026-08-05): selbst abgerechnete Touren als
    // "abgerechnet" markieren (kommen dann in die Abgerechnet-Liste/Excel) und
    // jeden Status wieder zuruecksetzen (z.B. faelschliches "Bereits vorhanden").
    const statusActions =
      (!bk.submitted
        ? '<button type="button" class="bk-action" data-action="mark-billed" title="Selbst abgerechnet: in Abgerechnet-Liste aufnehmen">Manuell abgerechnet</button>'
        : "") +
      (bk.submitted || bk.existing || bk.failed
        ? '<button type="button" class="bk-action" data-action="reset" title="Status zurücksetzen">Zurücksetzen</button>'
        : "");
    const submittedCell = `<div class="bk-status">${statusBadge}${statusActions}</div>`;

    tr.innerHTML = `
      <td>${stop.transport_number || "-"}</td>
      <td>${plateCheckLabel(stop)}</td>
      <td>${TYPE_LABELS[stop.stop_type] || stop.stop_type || "-"}</td>
      <td>${locationLabel(stop)}</td>
      <td><span class="${srcClass}">${src}</span></td>
      <td>${timeCellHtml(usedBoundaryLabel(stop.arrival_time_used, stop.arrival_source), sourceTone(stop.arrival_source), stop.arrival_source || "XP")}</td>
      <td>${timeCellHtml(usedBoundaryLabel(stop.departure_time_used, stop.departure_source), sourceTone(stop.departure_source), stop.departure_source || "XP")}</td>
      <td>${timeCellHtml(formatDateTimeForJustification(stop.count_start), context.startClass, context.startHint)}</td>
      <td>${
        stop.unload_window_fallback_applied
          ? timeCellHtml(
              formatDateTimeForJustification(
                stop.window_local || stop.window_start,
              ),
              "time-chip-excel",
              "Excel",
            )
          : timeCellHtml(
              formatDateTimeForJustification(
                stop.window_local || stop.window_start,
              ),
              context.windowClass,
              context.windowHint,
            )
      }</td>
      <td>${minutesToHours(stop.counted_standing_minutes)}</td>
      <td>${minutesToHours(stop.minutes_over_free)}</td>
      <td>${euro(stop.fee_eur)}</td>
      <td>${stop.billable_blocks || 0}</td>
      <td>${statusLabel}</td>
      <td><input type="checkbox" data-bk="billed" ${checkedAttr} /></td>
      <td>${submittedCell}</td>
    `;

    tr.querySelectorAll("input[data-bk]").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => event.stopPropagation());
    });

    const billedInput = tr.querySelector('input[data-bk="billed"]');
    if (billedInput) {
      billedInput.addEventListener("change", () => {
        bk.billed = Boolean(billedInput.checked);
        persistBookkeepingForCurrentImport();
      });
    }

    tr.querySelectorAll("button.bk-action").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = btn.getAttribute("data-action");
        if (action === "mark-billed") {
          bk.submitted = true;
          bk.billed = true;
          bk.failed = false;
          bk.existing = false;
          bk.manual = true;
        } else if (action === "reset") {
          bk.submitted = false;
          bk.billed = false;
          bk.failed = false;
          bk.existing = false;
          bk.manual = false;
        }
        persistBookkeepingForCurrentImport();
        render();
      });
    });

    tr.addEventListener("click", () => selectStop(stop));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectStop(stop);
      }
    });
    el.rows.appendChild(tr);
  }

  const dateActive =
    (el.dateFrom && el.dateFrom.value) || (el.dateTo && el.dateTo.value);
  if (dateActive) {
    const sum = stops.reduce((acc, s) => acc + Number(s.fee_eur || 0), 0);
    const chargeable = stops.filter((s) => Number(s.fee_eur || 0) > 0).length;
    const from = (el.dateFrom && el.dateFrom.value) || "…";
    const to = (el.dateTo && el.dateTo.value) || "…";
    setStatus(
      `Zeitraum ${from} bis ${to}: ${stops.length} Stopps, ${chargeable} abrechenbar, Summe ${euro(sum)}.`,
      "info",
    );
  }

  renderSettled();
}

function buildSettledStops() {
  const list = [];
  for (const stop of currentStops || []) {
    const entry = getBookkeepingEntry(stop);
    if (entry && entry.submitted) list.push(stop);
  }
  return list;
}

function stationLabelForStop(stop) {
  const type = String(stop.stop_type || "").toUpperCase();
  if (type === "UNLOADING") return "Entladestelle";
  if (type === "LOADING") return "Beladestelle";
  return "-";
}

function renderSettled() {
  if (!el.settledRows) return;
  const stops = buildSettledStops();
  el.settledRows.innerHTML = "";

  let sum = 0;
  for (const stop of stops) {
    sum += Number(stop.fee_eur || 0);
    const entryForRow = getBookkeepingEntry(stop);
    const tr = document.createElement("tr");
    tr.className = "result-row submitted-row";
    tr.innerHTML = `
      <td>${stop.transport_number || "-"}</td>
      <td>${TYPE_LABELS[stop.stop_type] || stop.stop_type || "-"}</td>
      <td>${locationLabel(stop)}</td>
      <td>${stationLabelForStop(stop)}</td>
      <td>${formatDateTimeForJustification(stop.window_local || stop.window_start)}</td>
      <td>${minutesToHours(stop.counted_standing_minutes)}</td>
      <td>${euro(stop.fee_eur)}</td>
      <td>
        <span class="tp-done">✓ Abgerechnet${entryForRow.manual ? " (manuell)" : ""}</span>
        <button type="button" class="settled-remove" title="Aus Abgerechnet entfernen">Entfernen</button>
      </td>
    `;
    const removeBtn = tr.querySelector(".settled-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (
          !window.confirm(
            `Tour ${stop.transport_number || ""} aus den abgerechneten Touren entfernen? Sie kommt dann nicht in die Excel.`,
          )
        ) {
          return;
        }
        const entry = getBookkeepingEntry(stop);
        entry.submitted = false;
        entry.billed = false;
        persistBookkeepingForCurrentImport();
        render();
      });
    }
    tr.addEventListener("click", () => selectStop(stop));
    el.settledRows.appendChild(tr);
  }

  if (el.settledCount) el.settledCount.textContent = String(stops.length);
  if (el.settledSum) el.settledSum.textContent = euro(sum);
}

function switchResultTab(tab) {
  const showSettled = tab !== "all";
  if (el.settledView) el.settledView.hidden = !showSettled;
  if (el.allView) el.allView.hidden = showSettled;
  if (el.tabSettled) el.tabSettled.classList.toggle("active", showSettled);
  if (el.tabAll) el.tabAll.classList.toggle("active", !showSettled);
}

async function exportSettled() {
  const stops = buildSettledStops();
  if (!stops.length) {
    setStatus("Keine abgerechneten Touren zum Exportieren.", "error");
    return;
  }

  const rows = stops.map((stop) => ({
    transport_number: String(stop.transport_number || "").trim(),
    amount_eur: Number(stop.fee_eur || 0),
  }));

  if (el.settledExportBtn) el.settledExportBtn.disabled = true;
  setStatus("Erstelle Excel der abgerechneten Touren …");

  try {
    const res = await fetch("/api/billing/settled-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });

    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        err = data.error || err;
      } catch {
        // ignore JSON parse error
      }
      throw new Error(err);
    }

    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `abgerechnete_touren_${stamp}.xlsx`);
    setStatus(`${rows.length} abgerechnete Touren exportiert.`, "success");
  } catch (error) {
    setStatus(error.message || "Export fehlgeschlagen.", "error");
  } finally {
    if (el.settledExportBtn) el.settledExportBtn.disabled = false;
  }
}

function ruleParams() {
  const lateArrivalGraceEnabled = lateArrivalGraceEnabledState;
  const lateArrivalGraceMinutes = Number(
    el.lateArrivalGraceMinutes?.value || 30,
  );
  const params = new URLSearchParams({
    scope: APP_SCOPE,
    freeMinutes: el.freeMinutes.value,
    blockMinutes: el.blockMinutes.value,
    blockRateEur: el.blockRateEur.value,
    triggerMinutes: el.triggerMinutes.value,
    lateArrivalGraceEnabled: lateArrivalGraceEnabled ? "1" : "0",
    lateArrivalGraceMinutes: String(
      Number.isFinite(lateArrivalGraceMinutes) ? lateArrivalGraceMinutes : 30,
    ),
  });
  // Excel-Abgleich nimmt die Zeitfenster ausschliesslich aus der Transporeon-
  // Excel. Ein alt gespeichertes Zeitfenster darf hier NIE einfliessen. Nur die
  // Sixfold-only-Seite nutzt weiter die separate Zeitfenster-Excel.
  if (!IS_SIXFOLD_ONLY_PAGE) {
    params.set("ignoreStoredWindows", "1");
  }
  return params;
}

function mergeUploadResults(results) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  if (!list.length) return null;

  const stops = list.flatMap((item) =>
    Array.isArray(item.stops) ? item.stops : [],
  );
  const summaries = list.map((item) => item.summary || {});
  const totalFeeEur = stops.reduce(
    (sum, stop) => sum + (stop.needs_review ? 0 : Number(stop.fee_eur || 0)),
    0,
  );

  return {
    summary: {
      transport_count: summaries.reduce(
        (sum, summary) => sum + Number(summary.transport_count || 0),
        0,
      ),
      stop_count: stops.length,
      chargeable_count: stops.filter(
        (s) => Number(s.fee_eur || 0) > 0 && !s.needs_review,
      ).length,
      review_count: stops.filter((s) => Boolean(s.needs_review)).length,
      gps_checked: summaries.some((summary) => Boolean(summary.gps_checked)),
      gps_used_count: stops.filter(
        (s) => s.arrival_source === "GPS" || s.departure_source === "GPS",
      ).length,
      gps_missing_count: stops.filter((s) => Boolean(s.gps_missing)).length,
      mixed_source_count: stops.filter(
        (s) => s.arrival_source !== s.departure_source,
      ).length,
      rebooking_suspected_count: stops.filter((s) =>
        Boolean(s.rebooking_suspected),
      ).length,
      total_fee_eur: totalFeeEur,
      total_fee_display: euro(totalFeeEur),
      date_filter_applied: summaries.some((summary) =>
        Boolean(summary.date_filter_applied),
      ),
      input_transport_count: summaries.reduce(
        (sum, summary) => sum + Number(summary.input_transport_count || 0),
        0,
      ),
      filtered_transport_count: summaries.reduce(
        (sum, summary) => sum + Number(summary.filtered_transport_count || 0),
        0,
      ),
      excluded_transport_count: summaries.reduce(
        (sum, summary) => sum + Number(summary.excluded_transport_count || 0),
        0,
      ),
      fallback_available: summaries.some((summary) =>
        Boolean(summary.fallback_available),
      ),
      fallback_applied: summaries.reduce(
        (sum, summary) => sum + Number(summary.fallback_applied || 0),
        0,
      ),
      fallback_candidates: summaries.reduce(
        (sum, summary) => sum + Number(summary.fallback_candidates || 0),
        0,
      ),
      fallback_overridden_existing: summaries.reduce(
        (sum, summary) =>
          sum + Number(summary.fallback_overridden_existing || 0),
        0,
      ),
      fallback_already_matching: summaries.reduce(
        (sum, summary) => sum + Number(summary.fallback_already_matching || 0),
        0,
      ),
    },
    stops,
    generated_at: new Date().toISOString(),
  };
}

function setImportOptions(imports, preferredId = "") {
  if (!el.importSelect) return;
  const list = Array.isArray(imports) ? imports : [];
  const urlImportId = importIdFromUrl();
  const batchMembers = currentBatchMembers().filter((item) =>
    list.some((candidate) => candidate.id === item.id),
  );
  const batchKey =
    batchMembers.length > 1
      ? batchSelectionKey(batchMembers.map((item) => item.id))
      : "";
  const targetId =
    preferredId ||
    urlImportId ||
    currentImportId ||
    batchKey ||
    list[0]?.id ||
    "";

  if (batchKey) {
    currentImportBatchIds = batchMembers.map((item) => item.id);
    currentImportId = batchMembers[0]?.id || currentImportId;
  }

  el.importSelect.innerHTML = "";
  if (!list.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Keine gespeicherten Importe";
    el.importSelect.appendChild(option);
    currentImportId = "";
    loadBookkeepingForImport("");
    syncImportWorkspace();
    return;
  }

  const filteredList =
    batchMembers.length > 1
      ? list.filter(
          (item) => !batchMembers.some((batchItem) => batchItem.id === item.id),
        )
      : list;

  if (batchMembers.length > 1) {
    const option = document.createElement("option");
    option.value = batchMembers[0]?.id || targetId;
    option.dataset.batchIds = batchMembers.map((item) => item.id).join("|");
    option.textContent = batchOptionLabel(
      buildBatchMeta(
        batchMembers,
        batchSelectionKey(batchMembers.map((item) => item.id)),
      ),
    );
    if (
      batchMembers[0]?.id === targetId ||
      batchSelectionKey(batchMembers.map((item) => item.id)) === targetId
    ) {
      option.selected = true;
    }
    el.importSelect.appendChild(option);
  }

  for (const item of filteredList) {
    const option = document.createElement("option");
    option.value = item.id;
    const importedAt = formatImportTimestamp(item.imported_at);
    const shortId = shortImportId(item.id);
    const dateRange =
      item.unload_date_from && item.unload_date_to
        ? ` · ${item.unload_date_from} bis ${item.unload_date_to}`
        : "";
    option.textContent =
      `${item.file_name} (${item.transport_count || 0})${dateRange}` +
      (shortId ? ` · #${shortId}` : "") +
      (importedAt ? ` · ${importedAt}` : "");
    if (item.id === targetId) option.selected = true;
    el.importSelect.appendChild(option);
  }

  currentImportId = el.importSelect.value || targetId;
  const available = new Set(list.map((item) => String(item.id || "").trim()));
  if (currentImportBatchIds.length) {
    setCurrentImportBatch(
      currentImportBatchIds.filter((id) => available.has(id)),
    );
  }
  loadBookkeepingForImport(currentImportId);
  setImportIdInUrl(currentImportId, true);
  syncImportWorkspace();
}

async function refreshImports(preferredId = "", silent = false) {
  const res = await fetch(
    `/api/imports?scope=${encodeURIComponent(APP_SCOPE)}`,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  currentImports = Array.isArray(data.imports) ? data.imports : [];
  setImportOptions(currentImports, preferredId);
  if (!silent) {
    const count = Array.isArray(data.imports) ? data.imports.length : 0;
    setStatus(`${count} gespeicherte Importe verfügbar.`, "success");
  }
  return data.imports || [];
}

function applyResult(data) {
  currentStops = data.stops || [];
  ensureBookkeepingEntries(currentStops);
  el.transportCount.textContent = data.summary.transport_count;
  el.stopCount.textContent = data.summary.stop_count;
  el.chargeableCount.textContent = data.summary.chargeable_count;
  el.reviewCount.textContent = data.summary.review_count;
  const gpsChecked = data.summary.gps_checked;
  el.gpsUsedCount.textContent = gpsChecked
    ? (data.summary.gps_used_count ?? 0)
    : "—";
  el.gpsMissingCount.textContent = gpsChecked
    ? (data.summary.gps_missing_count ?? 0)
    : "—";
  el.totalFee.textContent =
    data.summary.total_fee_display || euro(data.summary.total_fee_eur);

  el.resultPanel.hidden = false;
  render();
  const gpsNote = gpsChecked
    ? ` · GPS geprüft (${data.summary.gps_used_count} mit GPS)`
    : " · ohne GPS-Abgleich";
  const filterNote = data.summary.date_filter_applied
    ? ` · Datumsfilter: ${data.summary.filtered_transport_count}/${data.summary.input_transport_count} Transporte (ausgeschlossen: ${data.summary.excluded_transport_count})`
    : "";
  const mixNote =
    typeof data.summary.mixed_source_count === "number"
      ? ` · Mix-Stopps: ${data.summary.mixed_source_count}`
      : "";
  let fallbackNote = "";
  if (typeof data.summary.fallback_applied === "number") {
    if (!data.summary.fallback_available) {
      fallbackNote =
        " · Entladefenster-Fallback: keine Datei fuer diesen Bereich";
    } else if ((data.summary.fallback_candidates || 0) === 0) {
      fallbackNote =
        " · Entladefenster-Fallback: keine Entlade-Stopps im Import";
    } else {
      const overridden = Number(data.summary.fallback_overridden_existing || 0);
      const matched = Number(data.summary.fallback_already_matching || 0);
      fallbackNote = ` · Entladefenster aus Excel: ${data.summary.fallback_applied}/${data.summary.fallback_candidates || 0}`;
      if (overridden > 0) {
        fallbackNote += ` (davon ${overridden} vorhandene TP-Fenster ueberschrieben)`;
      }
      if (matched > 0) {
        fallbackNote += ` (${matched} bereits identisch)`;
      }
    }
  }
  const sixfoldNote =
    typeof data.summary.sixfold_only_count === "number" &&
    data.summary.sixfold_only_count > 0
      ? ` · aus Sixfold ergänzt: ${data.summary.sixfold_only_count}`
      : "";
  const sixfoldWindowNote =
    typeof data.summary.sixfold_unload_window_from_excel === "number" &&
    data.summary.sixfold_unload_window_from_excel > 0
      ? ` · Zeitfenster aus Excel (Sixfold): ${data.summary.sixfold_unload_window_from_excel}`
      : "";
  const createdNote =
    typeof data.summary.fallback_created_stops === "number" &&
    data.summary.fallback_created_stops > 0
      ? ` · Entlade-Stopps aus Zeitfenster erzeugt: ${data.summary.fallback_created_stops}`
      : "";
  setStatus(
    `${data.summary.transport_count} Transporte · ${data.summary.stop_count} Positionen${gpsNote}${filterNote}${mixNote}${fallbackNote}${sixfoldNote}${sixfoldWindowNote}${createdNote}.`,
    "success",
  );
}
function sixfoldHeaders() {
  const headers = {};
  const url = (el.sixfoldUrl.value || "").trim();
  const token = (el.sixfoldToken.value || "").trim();
  if (url && token) {
    headers["x-sixfold-url"] = url;
    headers["x-sixfold-token"] = token;
  }
  return headers;
}

function sixfoldParams() {
  const params = new URLSearchParams();

  // Harte Voreinstellung: keine Teil-Abrechnung mit Luecken.
  params.set("allowPartialLive", "0");

  // Seiten-Aufteilung: Seite 1 (Batch) = "sixfold" (nur an Sixfold
  // angebundene Transporte mit Kennzeichen), Seite 2 (Spotmarkt) = "spot"
  // (nur Touren ohne Kennzeichen mit Excel-Zeiten). Ohne Flag bleibt alles
  // zusammen ("all").
  const gpsScope = String(window.STANDGELD_GPS_SCOPE || "all")
    .trim()
    .toLowerCase();
  if (gpsScope === "sixfold" || gpsScope === "spot") {
    params.set("gpsScope", gpsScope);
  }

  // Zeitraum treibt den Sixfold-Abruf (und filtert Excel-Overlay).
  const from = ((el.batchDateFrom && el.batchDateFrom.value) || "").trim();
  const to = ((el.batchDateTo && el.batchDateTo.value) || "").trim();
  if (from) params.set("sixfoldDateFrom", from);
  if (to) params.set("sixfoldDateTo", to);

  const query = params.toString();
  return query ? `&${query}` : "";
}

// Reine Sixfold-Abrechnung: alle Touren im Zeitraum ueber Link + Token laden
// und abrechnen, ohne Excel als Basis. Excel/Zeitfenster koennen danach als
// Overlay drueberlaufen (Upload/Import laden).
async function loadFromSixfold() {
  const gps = sixfoldHeaders();
  if (!gps["x-sixfold-url"]) {
    setStatus("Bitte Sixfold-Link und Session-Token eintragen.", "error");
    return;
  }
  const from = ((el.batchDateFrom && el.batchDateFrom.value) || "").trim();
  const to = ((el.batchDateTo && el.batchDateTo.value) || "").trim();
  if (!from && !to) {
    setStatus(
      "Bitte einen Zeitraum (von/bis) für die Sixfold-Abrechnung wählen.",
      "error",
    );
    return;
  }

  setStatus("Lade alle Touren aus Sixfold im Zeitraum und rechne ab …");
  if (el.sixfoldBatchBtn) el.sixfoldBatchBtn.disabled = true;
  try {
    // Falls eine Datei gewaehlt, aber noch nicht importiert wurde, wird sie
    // hier uebernommen. Ein bereits importiertes Zeitfenster wird angewendet.
    await prepareUnloadWindowForRun();
    const params = ruleParams();
    // Kein importId + sixfoldOnly=1 -> strikt reine Sixfold-Abrechnung. Der
    // Server ignoriert dabei JEDE Transporeon-Excel; nur das importierte
    // Entladezeitfenster wird angewendet.
    const url =
      `/api/billing/export?${params.toString()}` +
      sixfoldParams() +
      "&sixfoldOnly=1";
    const res = await fetch(url, { headers: gps });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applyResult(data);
  } catch (error) {
    setStatus(error.message || "Sixfold-Abrechnung fehlgeschlagen.", "error");
  } finally {
    if (el.sixfoldBatchBtn) el.sixfoldBatchBtn.disabled = false;
    refreshUnloadWindowStatus();
  }
}

// Laedt eine gewaehlte Zeitfenster-Excel hoch (persistiert), damit sie beim
// Lauf angewendet wird. Ohne Auswahl passiert nichts.
async function prepareUnloadWindowForRun() {
  const file =
    el.unloadWindowFileInput?.files && el.unloadWindowFileInput.files[0];
  if (!file) return false;
  const res = await fetch(
    `/api/windows/upload?scope=${encodeURIComponent(APP_SCOPE)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return true;
}

async function load(forceRecalc = false) {
  const gps = sixfoldHeaders();
  const hasGps = Boolean(gps["x-sixfold-url"]);
  const importIds = activeImportIds();
  if (!importIds.length) {
    setStatus(
      "Bitte zuerst einen gespeicherten Import auswählen oder hochladen.",
      "error",
    );
    return;
  }
  setStatus(
    hasGps
      ? importIds.length > 1
        ? `Lade ${importIds.length} gespeicherte Importe + GPS-Abgleich …`
        : "Lade gespeicherten Import + GPS-Abgleich …"
      : importIds.length > 1
        ? `Lade ${importIds.length} gespeicherte Importe …`
        : "Lade gespeicherten Import …",
  );
  el.loadBtn.disabled = true;

  try {
    const results = [];
    for (const importId of importIds) {
      const params = ruleParams();
      params.set("importId", importId);
      if (forceRecalc) {
        params.set("forceRecalc", "1");
      }
      const baseUrl = `/api/billing/export?${params.toString()}`;
      const url = baseUrl + sixfoldParams();
      const res = await fetch(url, {
        headers: gps,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      results.push(data);
    }

    const merged = mergeUploadResults(results);
    if (merged) {
      applyResult(merged);
    }
    setImportIdInUrl(String(currentImportId || importIds[0] || ""), true);
    syncImportWorkspace();
  } catch (error) {
    setStatus(error.message || "Fehler beim Laden", "error");
  } finally {
    el.loadBtn.disabled = false;
  }
}

async function upload() {
  const files = Array.from(el.fileInput.files || []);
  if (!files.length) {
    setStatus("Bitte zuerst mindestens eine Excel-Datei auswählen.", "error");
    return;
  }

  setStatus(
    files.length === 1
      ? `Lade „${files[0].name}" hoch und rechne ab …`
      : `Lade ${files.length} Excel-Dateien hoch und gleiche ab …`,
  );
  el.uploadBtn.disabled = true;
  el.loadBtn.disabled = true;

  try {
    const gps = sixfoldHeaders();
    const headers = { "Content-Type": "application/octet-stream", ...gps };
    const results = [];
    let nextImportId = currentImportId;
    const uploadedImportIds = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const params = ruleParams();
      params.set("name", file.name);
      const baseUrl = `/api/billing/upload?${params.toString()}`;
      const url = baseUrl + sixfoldParams();

      setStatus(
        gps["x-sixfold-url"]
          ? `Datei ${index + 1}/${files.length}: „${file.name}" hochladen + Sixfold-Abgleich …`
          : `Datei ${index + 1}/${files.length}: „${file.name}" hochladen …`,
      );

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      results.push(data);
      const importedId = String(data.import?.id || "").trim();
      if (importedId) uploadedImportIds.push(importedId);
      nextImportId = importedId || nextImportId;
    }

    const merged = mergeUploadResults(results);
    if (merged) applyResult(merged);

    currentImportId = nextImportId;
    if (uploadedImportIds.length) {
      setCurrentImportBatch(uploadedImportIds);
    }
    await refreshImports(currentImportId, true);
    setImportIdInUrl(currentImportId, true);
    syncImportWorkspace();
    if (currentImportId) {
      setStatus(
        files.length === 1
          ? `Import gespeichert und abgerechnet: ${files[0].name}`
          : `${files.length} Importe gespeichert und gemeinsam abgerechnet.`,
        "success",
      );
    }
  } catch (error) {
    setStatus(error.message || "Fehler beim Hochladen", "error");
  } finally {
    el.uploadBtn.disabled = false;
    el.loadBtn.disabled = false;
  }
}

async function uploadUnloadWindows() {
  const file =
    el.unloadWindowFileInput?.files && el.unloadWindowFileInput.files[0];
  if (!file) {
    setStatus("Bitte zuerst eine Entladezeitfenster-Excel auswählen.", "error");
    return;
  }

  if (el.uploadUnloadWindowsBtn) el.uploadUnloadWindowsBtn.disabled = true;
  setStatus(`Importiere Entladezeitfenster aus „${file.name}“ …`);

  try {
    const res = await fetch(
      `/api/windows/upload?scope=${encodeURIComponent(APP_SCOPE)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const count = data.windows_count || 0;
    const ohneZeit = data.debug?.ohne_entladezeit || 0;
    const infoTeile = [`${count} Zeilen erkannt`];
    if (ohneZeit > 0) infoTeile.push(`${ohneZeit} ohne Entladezeit`);
    if (count === 0) {
      const sample = data.debug?.sample_ladenummern;
      setStatus(
        `Entladezeitfenster hochgeladen, aber 0 Zeilen erkannt. Bitte prüfe die Spaltenüberschriften deiner Excel (erwartet: Ladenummer, Entladezeit). Gefundene Rohdaten: ${sample ? JSON.stringify(sample) : "keine"}`,
        "error",
      );
    } else {
      setStatus(
        `Entladezeitfenster importiert: ${infoTeile.join(", ")}.`,
        "success",
      );
    }

    if (currentImportId) {
      await load(true);
    }
  } catch (error) {
    setStatus(
      error.message || "Entladezeitfenster-Import fehlgeschlagen.",
      "error",
    );
  } finally {
    if (el.uploadUnloadWindowsBtn) {
      const hasFile =
        el.unloadWindowFileInput?.files &&
        el.unloadWindowFileInput.files.length > 0;
      el.uploadUnloadWindowsBtn.disabled = !hasFile;
    }
    refreshUnloadWindowStatus();
  }
}

// Zeigt an, ob eine Zeitfenster-Excel gespeichert ist (Seite 1).
async function refreshUnloadWindowStatus() {
  if (!el.unloadWindowStatus && !el.deleteUnloadWindowsBtn) return;
  try {
    const res = await fetch(
      `/api/windows/status?scope=${encodeURIComponent(APP_SCOPE)}`,
    );
    const data = await res.json();
    const present = Boolean(data && data.present);
    if (el.deleteUnloadWindowsBtn)
      el.deleteUnloadWindowsBtn.disabled = !present;
    if (el.unloadWindowStatus) {
      if (present) {
        const when = data.uploaded_at
          ? formatImportTimestamp(data.uploaded_at)
          : "";
        el.unloadWindowStatus.textContent = `Zeitfenster aktiv: ${data.windows_count || 0} Zeilen${when ? ` · ${when}` : ""}`;
      } else {
        el.unloadWindowStatus.textContent = "Kein Zeitfenster geladen.";
      }
    }
  } catch (_error) {
    if (el.unloadWindowStatus) {
      el.unloadWindowStatus.textContent = "";
    }
  }
}

// Loescht die gespeicherte Zeitfenster-Excel.
async function deleteUnloadWindows() {
  const ok = window.confirm("Gespeichertes Zeitfenster wirklich löschen?");
  if (!ok) return;
  if (el.deleteUnloadWindowsBtn) el.deleteUnloadWindowsBtn.disabled = true;
  try {
    const res = await fetch(
      `/api/windows?scope=${encodeURIComponent(APP_SCOPE)}`,
      { method: "DELETE" },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus(
      data.deleted ? "Zeitfenster gelöscht." : "Kein Zeitfenster vorhanden.",
      "success",
    );
  } catch (error) {
    setStatus(
      error.message || "Zeitfenster konnte nicht gelöscht werden.",
      "error",
    );
  } finally {
    refreshUnloadWindowStatus();
  }
}

function openImportPage() {
  const importId = String(currentImportId || "").trim();
  if (!importId) {
    setStatus("Bitte zuerst einen Import auswählen.", "error");
    return;
  }
  const pagePath = window.location.pathname || "/batch.html";
  const target = `${pagePath}?import=${encodeURIComponent(importId)}`;
  window.open(target, "_blank", "noopener");
}

async function deleteSelectedImport() {
  const importId = String(
    currentImportId || el.importSelect?.value || "",
  ).trim();
  if (!importId) {
    setStatus("Bitte zuerst einen Import auswählen.", "error");
    return;
  }

  const meta = currentImportMeta();
  const label = meta?.file_name || importId;
  const batchIds =
    currentImportBatchIds.length > 1 ? [...currentImportBatchIds] : [importId];
  const ok = window.confirm(
    batchIds.length > 1
      ? `Mehrfachimport wirklich löschen?\n\n${label}\n(${batchIds.length} Dateien)`
      : `Upload wirklich löschen?\n\n${label}\n(${importId})`,
  );
  if (!ok) return;

  if (el.deleteImportBtn) el.deleteImportBtn.disabled = true;
  setStatus(
    batchIds.length > 1
      ? `Lösche Mehrfachimport „${label}“…`
      : `Lösche Upload „${label}“…`,
  );

  try {
    for (const id of batchIds) {
      const res = await fetch(`/api/imports/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      removeBookkeepingForImport(id);
    }

    setCurrentImportBatch([]);

    const remaining = await refreshImports("", true);
    const nextImportId = String(el.importSelect?.value || "").trim();
    if (importId !== nextImportId) {
      currentImportId = nextImportId;
    }
    if (!remaining.length) {
      clearResults();
      setImportIdInUrl("", true);
      setStatus(
        "Upload gelöscht. Es sind keine gespeicherten Importe mehr vorhanden.",
        "success",
      );
    } else {
      setImportIdInUrl(currentImportId, true);
      setStatus(
        `Upload gelöscht. Aktiver Upload: ${currentImportMeta()?.file_name || currentImportId}`,
        "success",
      );
    }
    syncImportWorkspace();
  } catch (error) {
    setStatus(error.message || "Upload konnte nicht gelöscht werden.", "error");
  } finally {
    if (el.deleteImportBtn) el.deleteImportBtn.disabled = false;
  }
}

async function selectiveSearch() {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (!file) {
    el.selectiveStatus.textContent = "Bitte zuerst eine Excel-Datei auswählen.";
    el.selectiveStatus.style.color = "#b91c1c";
    return;
  }

  const gps = sixfoldHeaders();
  if (!gps["x-sixfold-url"] || !gps["x-sixfold-token"]) {
    el.selectiveStatus.textContent =
      "Bitte Sixfold Fleet-Timeline-Link und Session-Token hinterlegen.";
    el.selectiveStatus.style.color = "#b91c1c";
    return;
  }

  el.selectiveStatus.textContent = `Suche „${file.name}" in Sixfold und gleiche ab …`;
  el.selectiveStatus.style.color = "#73675a";
  el.selectiveSearchBtn.disabled = true;

  try {
    const headers = { "Content-Type": "application/octet-stream", ...gps };
    const res = await fetch("/api/sixfold/selective-match", {
      method: "POST",
      headers,
      body: file,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    renderSelectiveResult(data);
  } catch (error) {
    el.selectiveStatus.textContent = `Fehler: ${error.message || "Abfrage fehlgeschlagen"}`;
    el.selectiveStatus.style.color = "#b91c1c";
  } finally {
    el.selectiveSearchBtn.disabled = false;
  }
}

function renderSelectiveResult(data) {
  const summary = data.summary || {};
  const matches = data.matches || [];
  const onlyInExcel = data.only_in_excel || [];
  const onlyInSixfold = data.only_in_sixfold || [];

  // Status-Text
  const statusText = `
    ✓ ${summary.matched_count || 0} Abgleiche · 
    ${summary.plate_matches_count || 0} Kennzeichen-Match · 
    ${summary.plate_mismatches_count || 0} Kennzeichen-Mismatch · 
    ∘ ${onlyInExcel.length} Nur Excel · 
    ∘ ${onlyInSixfold.length} Nur Sixfold
  `;
  el.selectiveStatus.textContent = statusText;
  el.selectiveStatus.style.color = "#166534";

  // Tabelle rendern
  const tbody = el.selectiveTable.querySelector("tbody");
  tbody.innerHTML = "";

  for (const match of matches) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><code>${match.transport_number}</code></td>
      <td>${match.excel_plate || "—"}</td>
      <td>${match.sixfold_plate || "—"}</td>
      <td>
        <span style="font-size: 0.85em; padding: 2px 6px; border-radius: 3px; ${
          match.plate_validation === "match"
            ? "background: #dcfce7; color: #166534;"
            : match.plate_validation === "mismatch"
              ? "background: #fecaca; color: #991b1b;"
              : "background: #f3f4f6; color: #4b5563;"
        }">
          ${
            match.plate_validation === "match"
              ? "✓ Match"
              : match.plate_validation === "mismatch"
                ? "✗ Mismatch"
                : match.plate_validation === "no_plates"
                  ? "◯ Keine Kennzeichen"
                  : match.plate_validation
          }
        </span>
      </td>
      <td>${match.usable_for_comparison ? "✓ Ja (XP)" : "✗ Nein"}</td>
    `;
    tbody.appendChild(row);
  }

  // Nur-in-Excel
  for (const item of onlyInExcel) {
    const row = document.createElement("tr");
    row.style.opacity = "0.6";
    row.innerHTML = `
      <td><code>${item.transport_number}</code></td>
      <td>${item.excel_plate || "—"}</td>
      <td>—</td>
      <td><span style="color: #666;">Nur Excel</span></td>
      <td>—</td>
    `;
    tbody.appendChild(row);
  }

  // Nur-in-Sixfold
  for (const item of onlyInSixfold) {
    const row = document.createElement("tr");
    row.style.opacity = "0.6";
    row.innerHTML = `
      <td><code>${item.transport_number}</code></td>
      <td>—</td>
      <td>${item.sixfold_plate || "—"}</td>
      <td><span style="color: #666;">Nur Sixfold</span></td>
      <td>—</td>
    `;
    tbody.appendChild(row);
  }

  el.selectivePanel.hidden = false;
  el.selectiveResult.hidden = false;
}

if (el.loadBtn) el.loadBtn.addEventListener("click", load);
if (el.uploadBtn) el.uploadBtn.addEventListener("click", upload);
if (el.importSelect) {
  el.importSelect.addEventListener("change", async () => {
    const selectedOption = el.importSelect.selectedOptions?.[0] || null;
    currentImportId = String(el.importSelect.value || "").trim();
    const batchIds = String(selectedOption?.dataset?.batchIds || "")
      .split("|")
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (batchIds.length > 1) {
      setCurrentImportBatch(batchIds);
    } else if (currentImportId) {
      setCurrentImportBatch([currentImportId]);
    }
    setImportIdInUrl(currentImportId, true);
    syncImportWorkspace();
    if (currentImportId) {
      await load();
    } else {
      clearResults();
      setStatus("Bitte einen gespeicherten Import auswählen.", "info");
    }
  });
}
if (el.refreshImportsBtn) {
  el.refreshImportsBtn.addEventListener("click", async () => {
    try {
      await refreshImports(currentImportId);
    } catch (error) {
      setStatus(
        error.message || "Importe konnten nicht geladen werden.",
        "error",
      );
    }
  });
}
if (el.openImportPageBtn) {
  el.openImportPageBtn.addEventListener("click", openImportPage);
}
if (el.deleteImportBtn) {
  el.deleteImportBtn.addEventListener("click", deleteSelectedImport);
}
if (el.fileInput) {
  el.fileInput.addEventListener("change", () => {
    const hasFile = el.fileInput.files && el.fileInput.files.length;
    if (el.uploadBtn) el.uploadBtn.disabled = !hasFile;
    if (el.selectiveSearchBtn) el.selectiveSearchBtn.disabled = !hasFile;
  });
}
if (el.unloadWindowFileInput) {
  el.unloadWindowFileInput.addEventListener("change", () => {
    const hasFile =
      el.unloadWindowFileInput.files && el.unloadWindowFileInput.files.length;
    if (el.uploadUnloadWindowsBtn) {
      el.uploadUnloadWindowsBtn.disabled = !hasFile;
    }
  });
}
if (el.uploadUnloadWindowsBtn) {
  el.uploadUnloadWindowsBtn.addEventListener("click", uploadUnloadWindows);
}
if (el.lateArrivalGraceToggle) {
  el.lateArrivalGraceToggle.addEventListener("click", () => {
    lateArrivalGraceEnabledState = !lateArrivalGraceEnabledState;
    persistRuleSettingsAndReload();
  });
}
if (el.lateArrivalGraceMinutes) {
  el.lateArrivalGraceMinutes.addEventListener("input", persistRuleSettings);
  el.lateArrivalGraceMinutes.addEventListener(
    "change",
    persistRuleSettingsAndReload,
  );
}
if (el.sixfoldUrl) {
  el.sixfoldUrl.addEventListener("input", persistSixfoldCredentials);
  el.sixfoldUrl.addEventListener("change", persistSixfoldCredentials);
}
if (el.sixfoldToken) {
  el.sixfoldToken.addEventListener("input", persistSixfoldCredentials);
  el.sixfoldToken.addEventListener("change", persistSixfoldCredentials);
}
if (el.selectiveSearchBtn) {
  el.selectiveSearchBtn.addEventListener("click", selectiveSearch);
}
if (el.filterMode) el.filterMode.addEventListener("change", render);
if (el.sortMode) el.sortMode.addEventListener("change", render);
if (el.sixfoldBatchBtn) {
  el.sixfoldBatchBtn.addEventListener("click", loadFromSixfold);
}
if (el.dateFrom) el.dateFrom.addEventListener("change", render);
if (el.dateTo) el.dateTo.addEventListener("change", render);
if (el.clearDateFilterBtn) {
  el.clearDateFilterBtn.addEventListener("click", () => {
    if (el.dateFrom) el.dateFrom.value = "";
    if (el.dateTo) el.dateTo.value = "";
    render();
  });
}
if (el.bookkeepingExportBtn) {
  el.bookkeepingExportBtn.addEventListener("click", exportBookkeeping);
}
if (el.openTransporeonBtn) {
  el.openTransporeonBtn.addEventListener("click", openTransporeonSession);
}
if (el.applyTransporeonBtn) {
  el.applyTransporeonBtn.addEventListener("click", () =>
    applyTransporeonSurcharges(false),
  );
}
if (el.retryFailedTransporeonBtn) {
  el.retryFailedTransporeonBtn.addEventListener("click", () =>
    applyTransporeonSurcharges(true),
  );
}
if (el.resetTransporeonBtn) {
  el.resetTransporeonBtn.addEventListener("click", resetTransporeonSession);
}
if (el.tabSettled) {
  el.tabSettled.addEventListener("click", () => switchResultTab("settled"));
}
if (el.tabAll) {
  el.tabAll.addEventListener("click", () => switchResultTab("all"));
}
if (el.settledExportBtn) {
  el.settledExportBtn.addEventListener("click", exportSettled);
}
if (el.closeStopDetailModalBtn) {
  el.closeStopDetailModalBtn.addEventListener("click", closeStopDetailModal);
}
if (el.closeStopDetailModalBtn2) {
  el.closeStopDetailModalBtn2.addEventListener("click", closeStopDetailModal);
}
if (el.copyJustificationBtn) {
  el.copyJustificationBtn.addEventListener("click", copyJustificationText);
}
if (el.stopDetailModal) {
  el.stopDetailModal.addEventListener("click", (event) => {
    if (event.target === el.stopDetailModal) closeStopDetailModal();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeStopDetailModal();
});

restoreSixfoldCredentials();
restoreRuleSettings();
setCurrentImportBatch(readImportBatchStorage());

if (el.deleteUnloadWindowsBtn) {
  el.deleteUnloadWindowsBtn.addEventListener("click", deleteUnloadWindows);
}

if (IS_SIXFOLD_ONLY_PAGE) {
  // Seite 1: keine Transporeon-Importe laden. Nur Zeitfenster-Status zeigen.
  refreshUnloadWindowStatus();
  setStatus("Bereit. Sixfold-Link, Token und Zeitraum wählen.");
} else {
  refreshImports("", true)
    .then(async () => {
      setStatus("Bereit. Excel hochladen oder gespeicherten Import auswählen.");
      const importFromUrl = importIdFromUrl();
      if (importFromUrl && currentImportId === importFromUrl) {
        await load();
      }
    })
    .catch(() => {
      setStatus("Bereit. Excel hochladen oder gespeicherten Import auswählen.");
    });
}
