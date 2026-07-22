"use strict";

const APP_SCOPE = (() => {
  const raw = String(window.STANDGELD_SCOPE || "fernverkehr")
    .trim()
    .toLowerCase();
  return raw === "nahverkehr" ? "nahverkehr" : "fernverkehr";
})();

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
  bookkeepingOnlyMarked: document.getElementById("bookkeepingOnlyMarked"),
  bookkeepingExportBtn: document.getElementById("bookkeepingExportBtn"),
  rows: document.getElementById("rows"),
  stopDetailModal: document.getElementById("stopDetailModal"),
  stopDetailTitle: document.getElementById("stopDetailTitle"),
  stopDetailMeta: document.getElementById("stopDetailMeta"),
  stopDetailRows: document.getElementById("stopDetailRows"),
  closeStopDetailModalBtn: document.getElementById("closeStopDetailModalBtn"),
  closeStopDetailModalBtn2: document.getElementById("closeStopDetailModalBtn2"),
  openJustificationBtn: document.getElementById("openJustificationBtn"),
  justificationModal: document.getElementById("justificationModal"),
  justificationText: document.getElementById("justificationText"),
  copyJustificationBtn: document.getElementById("copyJustificationBtn"),
  closeJustificationModalBtn: document.getElementById(
    "closeJustificationModalBtn",
  ),
  closeJustificationModalBtn2: document.getElementById(
    "closeJustificationModalBtn2",
  ),
};

let currentStops = [];
let activeDetailStop = null;
let currentImportId = "";
let currentImports = [];
const bookkeepingByKey = new Map();
const BOOKKEEPING_STORAGE_KEY = `standgeld.bookkeeping.${APP_SCOPE}.v1`;
const SIXFOLD_STORAGE_KEY = "standgeld.sixfold.credentials.v1";

const REASON_LABELS = {
  chargeable: "Abrechenbar",
  within_free_time: "Innerhalb Freizeit",
  below_trigger: "Unter Auslöser",
  missing_data: "Daten fehlen",
  implausible_duration: "Unplausibel (Prüfen)",
};

const TYPE_LABELS = {
  LOADING: "Laden",
  UNLOADING: "Entladen",
};

function setStatus(text, type = "info") {
  el.status.textContent = text;
  el.status.style.color =
    type === "error" ? "#b91c1c" : type === "success" ? "#166534" : "#73675a";
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
    lateArrivalGraceEnabled: Boolean(el.lateArrivalGraceEnabled?.checked),
    lateArrivalGraceMinutes: Number(el.lateArrivalGraceMinutes?.value || 45),
  });
}

function syncLateArrivalGraceToggle() {
  if (!el.lateArrivalGraceToggle || !el.lateArrivalGraceEnabled) return;
  const enabled = Boolean(el.lateArrivalGraceEnabled.checked);
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

function restoreRuleSettings() {
  const stored = readRuleStorage();
  if (el.lateArrivalGraceEnabled) {
    el.lateArrivalGraceEnabled.checked = Boolean(
      stored.lateArrivalGraceEnabled,
    );
  }
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

function openStopDetailModal(stop) {
  if (!el.stopDetailModal || !stop) return;
  activeDetailStop = stop;

  const typeLabel = TYPE_LABELS[stop.stop_type] || stop.stop_type || "-";
  el.stopDetailTitle.textContent = `${stop.transport_number || "-"} · ${typeLabel}`;

  const source = sourceLabel(stop);
  const kfz = plateCheckLabel(stop);
  const usedStanding = minutesToHours(
    standingMinutesFromIso(stop.arrival_time_used, stop.departure_time_used) ??
      stop.counted_standing_minutes,
  );
  const countedStanding = minutesToHours(stop.counted_standing_minutes);
  const freeStanding = minutesToHours(stop.minutes_over_free);
  const windowLocal = stop.window_local || "-";
  const countStartLocal = isoToLocal(stop.count_start);
  const rebookingNote = stop.rebooking_suspected
    ? " · ⚠ Umbuchung/Pause erkannt: gezählt ab GPS-Ankunft (Prüffall)"
    : "";
  const amountNote = ` · Abrechenbare Summe: ${euro(stop.fee_eur)}`;
  el.stopDetailMeta.textContent =
    `Zeitfenster: ${windowLocal} · Zählbeginn: ${countStartLocal} · ` +
    `Quelle: ${source} · KFZ: ${kfz} · Ist-Standzeit: ${usedStanding} · ` +
    `Ab Zählbeginn: ${countedStanding} · 2h frei: ${freeStanding}` +
    amountNote +
    rebookingNote;

  const xpArrival = isoToLocal(stop.xp_arrival_time);
  const xpDeparture = isoToLocal(stop.xp_departure_time);
  const gpsArrival = isoToLocal(stop.gps_arrival_time);
  const gpsDeparture = isoToLocal(stop.gps_departure_time);
  const usedArrival = isoToLocal(stop.arrival_time_used);
  const usedDeparture = isoToLocal(stop.departure_time_used);

  const xpStanding = minutesToHours(
    standingMinutesFromIso(stop.xp_arrival_time, stop.xp_departure_time),
  );
  const gpsStanding = minutesToHours(
    standingMinutesFromIso(stop.gps_arrival_time, stop.gps_departure_time),
  );

  el.stopDetailRows.innerHTML =
    detailRowHtml("Ankunft", xpArrival, gpsArrival, usedArrival) +
    detailRowHtml("Abfahrt", xpDeparture, gpsDeparture, usedDeparture) +
    detailRowHtml("Standzeit (Ist)", xpStanding, gpsStanding, usedStanding) +
    detailRowHtml("Standzeit ab Zählbeginn", "-", "-", countedStanding) +
    detailRowHtml("2h frei", "-", "-", freeStanding) +
    fallbackStatusRowHtml(stop);

  el.stopDetailModal.hidden = false;
}

function closeStopDetailModal() {
  if (!el.stopDetailModal) return;
  el.stopDetailModal.hidden = true;
}

function billedMinutes(stop) {
  if (!stop || !stop.chargeable) return 0;
  return Math.max(0, Math.round(Number(stop.minutes_over_free || 0)));
}

function buildJustificationText(stop) {
  if (!stop) return "";

  const arrivalUsed = isoToLocal(stop.arrival_time_used);
  const departureUsed = isoToLocal(stop.departure_time_used);
  const standing = minutesToHours(
    standingMinutesFromIso(stop.arrival_time_used, stop.departure_time_used) ??
      stop.counted_standing_minutes,
  );
  const freeText = minutesToHours(stop.free_minutes || 120);
  const billedText = minutesToHours(billedMinutes(stop));

  return [
    `Ankunft: ${arrivalUsed}`,
    `Abfahrt: ${departureUsed}`,
    `Standzeit: ${standing}`,
    `2h frei: ${freeText}`,
    `Abzurechnende Zeit (exakt): ${billedText}`,
    `Abrechenbare Summe: ${euro(stop.fee_eur)}`,
  ].join("\n");
}

function openJustificationModal() {
  if (!el.justificationModal || !el.justificationText || !activeDetailStop) {
    return;
  }
  el.justificationText.value = buildJustificationText(activeDetailStop);
  el.justificationModal.hidden = false;
}

function closeJustificationModal() {
  if (!el.justificationModal) return;
  el.justificationModal.hidden = true;
}

async function copyJustificationText() {
  const text = String(el.justificationText?.value || "").trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Begründung in Zwischenablage kopiert.", "success");
  } catch {
    if (el.justificationText) {
      el.justificationText.focus();
      el.justificationText.select();
      document.execCommand("copy");
      setStatus("Begründung in Zwischenablage kopiert.", "success");
    }
  }
}

function filteredStops() {
  const mode = el.filterMode.value;
  if (mode === "chargeable") return currentStops.filter((s) => s.fee_eur > 0);
  if (mode === "review") return currentStops.filter((s) => s.needs_review);
  if (mode === "gpsMissing") return currentStops.filter((s) => s.gps_missing);
  return currentStops;
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
  if (!stop.gps_checked || !stop.gps_plate_match) return "-";
  const excelPlate = (stop.excel_license_plate || "").trim();
  const gpsPlate = (stop.gps_license_plate || "").trim();
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

  for (const stop of stops) {
    const tr = document.createElement("tr");
    tr.className = "result-row";
    if (stop.needs_review) tr.classList.add("review-row");
    else if (stop.fee_eur > 0) tr.classList.add("chargeable-row");
    tr.tabIndex = 0;

    const statusLabel = stop.needs_review
      ? "Prüfen"
      : REASON_LABELS[stop.reason] || stop.reason || "-";

    const src = sourceLabel(stop);
    const srcClass = sourceClass(stop);

    const bk = getBookkeepingEntry(stop);
    const checkedAttr = bk.billed ? "checked" : "";

    tr.innerHTML = `
      <td>${stop.transport_number || "-"}</td>
      <td>${plateCheckLabel(stop)}</td>
      <td>${TYPE_LABELS[stop.stop_type] || stop.stop_type || "-"}</td>
      <td><span class="${srcClass}">${src}</span></td>
      <td>${stop.arrival_local || "-"}</td>
      <td>${stop.departure_local || "-"}</td>
      <td>${isoToLocal(stop.count_start)}</td>
      <td>${stop.window_local || "-"}</td>
      <td>${minutesToHours(stop.counted_standing_minutes)}</td>
      <td>${minutesToHours(stop.minutes_over_free)}</td>
      <td>${euro(stop.fee_eur)}</td>
      <td>${stop.billable_blocks || 0}</td>
      <td>${statusLabel}</td>
      <td><input type="checkbox" data-bk="billed" ${checkedAttr} /></td>
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

    tr.addEventListener("click", () => openStopDetailModal(stop));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openStopDetailModal(stop);
      }
    });
    el.rows.appendChild(tr);
  }
}

function ruleParams() {
  const lateArrivalGraceEnabled = Boolean(el.lateArrivalGraceEnabled?.checked);
  const lateArrivalGraceMinutes = Number(
    el.lateArrivalGraceMinutes?.value || 45,
  );
  return new URLSearchParams({
    scope: APP_SCOPE,
    freeMinutes: el.freeMinutes.value,
    blockMinutes: el.blockMinutes.value,
    blockRateEur: el.blockRateEur.value,
    triggerMinutes: el.triggerMinutes.value,
    lateArrivalGraceEnabled: lateArrivalGraceEnabled ? "1" : "0",
    lateArrivalGraceMinutes: String(
      Number.isFinite(lateArrivalGraceMinutes) ? lateArrivalGraceMinutes : 45,
    ),
  });
}

function setImportOptions(imports, preferredId = "") {
  if (!el.importSelect) return;
  const list = Array.isArray(imports) ? imports : [];
  const urlImportId = importIdFromUrl();
  const targetId =
    preferredId || urlImportId || currentImportId || list[0]?.id || "";

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

  for (const item of list) {
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
        " · Entladefenster-Fallback: keine fehlenden Entladefenster";
    } else {
      fallbackNote = ` · Entladefenster ersetzt: ${data.summary.fallback_applied}/${data.summary.fallback_candidates || 0}`;
    }
  }
  setStatus(
    `${data.summary.transport_count} Transporte · ${data.summary.stop_count} Positionen${gpsNote}${filterNote}${mixNote}${fallbackNote}.`,
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

  const query = params.toString();
  return query ? `&${query}` : "";
}

async function load(forceRecalc = false) {
  const gps = sixfoldHeaders();
  const hasGps = Boolean(gps["x-sixfold-url"]);
  const importId = String(
    currentImportId || el.importSelect?.value || "",
  ).trim();
  if (!importId) {
    setStatus(
      "Bitte zuerst einen gespeicherten Import auswählen oder hochladen.",
      "error",
    );
    return;
  }
  setStatus(
    hasGps
      ? "Lade gespeicherten Import + GPS-Abgleich …"
      : "Lade gespeicherten Import …",
  );
  el.loadBtn.disabled = true;

  try {
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

    applyResult(data);
    setImportIdInUrl(importId, true);
    syncImportWorkspace();
  } catch (error) {
    setStatus(error.message || "Fehler beim Laden", "error");
  } finally {
    el.loadBtn.disabled = false;
  }
}

async function upload() {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (!file) {
    setStatus("Bitte zuerst eine Excel-Datei auswählen.", "error");
    return;
  }

  setStatus(`Lade „${file.name}" hoch und rechne ab …`);
  el.uploadBtn.disabled = true;
  el.loadBtn.disabled = true;

  try {
    const params = ruleParams();
    params.set("name", file.name);
    const gps = sixfoldHeaders();
    const headers = { "Content-Type": "application/octet-stream", ...gps };
    const baseUrl = `/api/billing/upload?${params.toString()}`;
    const url = baseUrl + sixfoldParams();
    if (gps["x-sixfold-url"]) {
      setStatus(
        `Lade „${file.name}" hoch, gleiche mit Sixfold ab und rechne ab …`,
      );
    } else {
      setStatus(`Lade „${file.name}" hoch und rechne ab …`);
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    applyResult(data);
    currentImportId = String(data.import?.id || "").trim() || currentImportId;
    await refreshImports(currentImportId, true);
    setImportIdInUrl(currentImportId, true);
    syncImportWorkspace();
    if (currentImportId) {
      setStatus(
        `Import gespeichert und abgerechnet: ${data.import?.file_name || file.name}`,
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

    setStatus(
      `Entladezeitfenster importiert (${data.windows_count || 0} Zeilen).`,
      "success",
    );

    if (currentImportId) {
      await load();
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
  const ok = window.confirm(
    `Upload wirklich löschen?\n\n${label}\n(${importId})`,
  );
  if (!ok) return;

  if (el.deleteImportBtn) el.deleteImportBtn.disabled = true;
  setStatus(`Lösche Upload „${label}“…`);

  try {
    const res = await fetch(`/api/imports/${encodeURIComponent(importId)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    removeBookkeepingForImport(importId);

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

el.loadBtn.addEventListener("click", load);
el.uploadBtn.addEventListener("click", upload);
if (el.importSelect) {
  el.importSelect.addEventListener("change", async () => {
    currentImportId = String(el.importSelect.value || "").trim();
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
el.fileInput.addEventListener("change", () => {
  const hasFile = el.fileInput.files && el.fileInput.files.length;
  el.uploadBtn.disabled = !hasFile;
  el.selectiveSearchBtn.disabled = !hasFile;
});
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
if (el.lateArrivalGraceEnabled) {
  el.lateArrivalGraceEnabled.addEventListener(
    "change",
    persistRuleSettingsAndReload,
  );
}
if (el.lateArrivalGraceToggle && el.lateArrivalGraceEnabled) {
  el.lateArrivalGraceToggle.addEventListener("click", () => {
    el.lateArrivalGraceEnabled.checked = !el.lateArrivalGraceEnabled.checked;
    el.lateArrivalGraceEnabled.dispatchEvent(new Event("change"));
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
el.selectiveSearchBtn.addEventListener("click", selectiveSearch);
el.filterMode.addEventListener("change", render);
if (el.bookkeepingExportBtn) {
  el.bookkeepingExportBtn.addEventListener("click", exportBookkeeping);
}
if (el.closeStopDetailModalBtn) {
  el.closeStopDetailModalBtn.addEventListener("click", closeStopDetailModal);
}
if (el.closeStopDetailModalBtn2) {
  el.closeStopDetailModalBtn2.addEventListener("click", closeStopDetailModal);
}
if (el.openJustificationBtn) {
  el.openJustificationBtn.addEventListener("click", openJustificationModal);
}
if (el.copyJustificationBtn) {
  el.copyJustificationBtn.addEventListener("click", copyJustificationText);
}
if (el.closeJustificationModalBtn) {
  el.closeJustificationModalBtn.addEventListener(
    "click",
    closeJustificationModal,
  );
}
if (el.closeJustificationModalBtn2) {
  el.closeJustificationModalBtn2.addEventListener(
    "click",
    closeJustificationModal,
  );
}
if (el.stopDetailModal) {
  el.stopDetailModal.addEventListener("click", (event) => {
    if (event.target === el.stopDetailModal) closeStopDetailModal();
  });
}
if (el.justificationModal) {
  el.justificationModal.addEventListener("click", (event) => {
    if (event.target === el.justificationModal) closeJustificationModal();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (el.justificationModal && !el.justificationModal.hidden) {
    closeJustificationModal();
    return;
  }
  closeStopDetailModal();
});

restoreSixfoldCredentials();
restoreRuleSettings();

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
