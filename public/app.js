const el = {
  url: document.getElementById("url"),
  periodMode: document.getElementById("periodMode"),
  referenceDate: document.getElementById("referenceDate"),
  rangeFrom: document.getElementById("rangeFrom"),
  rangeTo: document.getElementById("rangeTo"),
  transportNumber: document.getElementById("transportNumber"),
  tourId: document.getElementById("tourId"),
  sessionToken: document.getElementById("sessionToken"),
  timeWindowFile: document.getElementById("timeWindowFile"),
  importTimeWindowBtn: document.getElementById("importTimeWindowBtn"),
  clearTimeWindowBtn: document.getElementById("clearTimeWindowBtn"),
  timeWindowMeta: document.getElementById("timeWindowMeta"),
  freeMinutes: document.getElementById("freeMinutes"),
  unitMinutes: document.getElementById("unitMinutes"),
  unitPrice: document.getElementById("unitPrice"),
  thresholdEur: document.getElementById("thresholdEur"),
  capEur: document.getElementById("capEur"),
  lateArrivalGraceMinutes: document.getElementById("lateArrivalGraceMinutes"),
  lateArrivalGraceToggle: document.getElementById("lateArrivalGraceToggle"),
  runBtn: document.getElementById("runBtn"),
  status: document.getElementById("status"),
  resultPanel: document.getElementById("resultPanel"),
  amount: document.getElementById("amount"),
  positions: document.getElementById("positions"),
  units: document.getElementById("units"),
  dateSort: document.getElementById("dateSort"),
  dateFrom: document.getElementById("dateFrom"),
  dateTo: document.getElementById("dateTo"),
  dateClearBtn: document.getElementById("dateClearBtn"),
  bookkeepingOnlyMarked: document.getElementById("bookkeepingOnlyMarked"),
  bookkeepingExportBtn: document.getElementById("bookkeepingExportBtn"),
  transporeonDryRun: document.getElementById("transporeonDryRun"),
  openTransporeonBtn: document.getElementById("openTransporeonBtn"),
  applyTransporeonBtn: document.getElementById("applyTransporeonBtn"),
  retryFailedTransporeonBtn: document.getElementById(
    "retryFailedTransporeonBtn",
  ),
  tabAll: document.getElementById("tabAll"),
  tabSettled: document.getElementById("tabSettled"),
  allView: document.getElementById("allView"),
  settledView: document.getElementById("settledView"),
  settledCount: document.getElementById("settledCount"),
  settledSum: document.getElementById("settledSum"),
  settledExportBtn: document.getElementById("settledExportBtn"),
  settledRows: document.getElementById("settledRows"),
  rows: document.getElementById("rows"),
  surchargeModal: document.getElementById("surchargeModal"),
  surchargeTitle: document.getElementById("surchargeTitle"),
  surchargeMeta: document.getElementById("surchargeMeta"),
  surchargeDetailRows: document.getElementById("surchargeDetailRows"),
  surchargeText: document.getElementById("surchargeText"),
  copySurchargeBtn: document.getElementById("copySurchargeBtn"),
  closeSurchargeModalBtn: document.getElementById("closeSurchargeModalBtn"),
  closeSurchargeModalBtn2: document.getElementById("closeSurchargeModalBtn2"),
};

let importedTimeWindows = [];
let latestStops = [];
let activeStop = null;
let lateArrivalGraceEnabledState = false;
const bookkeepingByKey = new Map();
const URL_STORAGE_KEY = "standgeld.sixfoldUrl";
const SESSION_TOKEN_STORAGE_KEY = "standgeld.sessionToken";
const SINGLE_RULES_STORAGE_KEY = "standgeld.single.rules.v1";
const SINGLE_BOOKKEEPING_STORAGE_KEY = "standgeld.single.bookkeeping.v1";

// Wenn die Seite auf Render (nicht localhost) laeuft, delegiert die Transporeon-
// Automatik an den lokalen Motor auf http://localhost:3100.
const IS_LOCAL_HOST =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";
const AUTOMATION_BASE = IS_LOCAL_HOST ? "" : "http://localhost:3100";

function automationUnreachableHint() {
  return (
    "Lokaler Automations-Motor nicht erreichbar. Bitte die App lokal starten " +
    "(Standgeld-App starten.cmd) und dieses Fenster auf http://localhost:3100 nutzen."
  );
}

function stopKey(stop) {
  return [
    String(stop.transport_number || "").trim(),
    String(stop.type || "").trim(),
    String(stop.arrival_time || "").trim(),
    String(stop.departure_time || "").trim(),
    String(stop.rule_start_display || "").trim(),
  ].join("|");
}

function readSingleBookkeepingStorage() {
  try {
    const raw = localStorage.getItem(SINGLE_BOOKKEEPING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeSingleBookkeepingStorage(storage) {
  try {
    localStorage.setItem(
      SINGLE_BOOKKEEPING_STORAGE_KEY,
      JSON.stringify(storage || {}),
    );
  } catch (_error) {
    // ignore
  }
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

function restoreBookkeepingEntries(stops) {
  bookkeepingByKey.clear();
  const storage = readSingleBookkeepingStorage();
  for (const stop of stops || []) {
    const key = stopKey(stop);
    bookkeepingByKey.set(key, {
      billed: Boolean(storage[key]?.billed),
      submitted: Boolean(storage[key]?.submitted),
      failed: Boolean(storage[key]?.failed),
      existing: Boolean(storage[key]?.existing),
      manual: Boolean(storage[key]?.manual),
    });
  }
}

function persistBookkeepingEntries() {
  const storage = {};
  for (const [key, entry] of bookkeepingByKey.entries()) {
    storage[key] = {
      billed: Boolean(entry?.billed),
      submitted: Boolean(entry?.submitted),
      failed: Boolean(entry?.failed),
      existing: Boolean(entry?.existing),
      manual: Boolean(entry?.manual),
    };
  }
  writeSingleBookkeepingStorage(storage);
}

function buildBookkeepingRows(onlyMarked) {
  const rows = [];
  for (const stop of latestStops || []) {
    const entry = getBookkeepingEntry(stop);
    if (onlyMarked && !entry.billed) continue;
    rows.push({
      transport_number: String(stop.transport_number || "").trim(),
      amount_eur: Number(stop.amount_eur || 0),
      surcharge_id: "",
    });
  }
  return rows;
}

function buildTransporeonSurchargeRows(onlyFailed = false) {
  const rows = [];
  for (const stop of latestStops || []) {
    if (!stop || Number(stop.amount_eur || 0) <= 0) continue;
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
      stop_type: String(stop.type || "")
        .trim()
        .toUpperCase(),
      amount_eur: Number(stop.amount_eur || 0),
      description: buildSurchargeDescription(stop),
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
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.list_ready) {
      setStatus(
        `Automations-Fenster bereit: ${data.row_count || 0} Transportzeilen erkannt.`,
        "success",
      );
    } else {
      setStatus(
        "Automations-Fenster geöffnet. Bitte in DIESEM Fenster bei Transporeon einloggen und 'Zugewiesene Transporte' öffnen.",
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

async function applyTransporeonSurcharges(onlyFailed = false) {
  const rows = buildTransporeonSurchargeRows(onlyFailed);
  if (!rows.length) {
    setStatus(
      onlyFailed
        ? "Keine fehlgeschlagenen Positionen zum erneuten Beantragen vorhanden."
        : "Keine als „abgerechnet“ markierten Positionen für Transporeon vorhanden.",
      "error",
    );
    return;
  }

  const dryRun = Boolean(el.transporeonDryRun?.checked);
  const confirmText = dryRun
    ? `Trockenlauf für ${rows.length} Positionen starten?`
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
      : `Beantrage ${rows.length} markierte Zuschläge in Transporeon …`,
  );

  try {
    const res = await fetch(
      `${AUTOMATION_BASE}/api/transporeon/surcharges/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, keepBrowserOpen: true, items: rows }),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const doneTransports = [];
    if (!dryRun && Array.isArray(data.processed)) {
      const successKeys = new Set(
        data.processed
          .filter((item) => item.status === "applied")
          .map((item) => String(item.stop_key || "").trim())
          .filter(Boolean),
      );
      // Bereits vorhandene Standzeit-Zeilen: eigener Zustand. Nicht von diesem
      // Lauf abgerechnet -> markieren, aus "Abgerechnet"/Excel nehmen.
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
        for (const stop of latestStops || []) {
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
        persistBookkeepingEntries();
        renderStops(latestStops);
      }
    }

    const success = Number(data.summary?.success_count || 0);
    const alreadyExists = Number(data.summary?.already_exists_count || 0);
    const savedNoDecision = Number(data.summary?.saved_no_decision_count || 0);
    const failure = Number(data.summary?.failure_count || 0);
    if (dryRun) {
      setStatus(
        `Trockenlauf fertig: ${success} bereit, ${failure + alreadyExists} nicht gefunden/fehlerhaft.`,
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
        // ignore
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

function writeSingleRuleStorage(value) {
  try {
    localStorage.setItem(SINGLE_RULES_STORAGE_KEY, JSON.stringify(value));
  } catch (_error) {
    // ignore
  }
}

function readSingleRuleStorage() {
  try {
    const raw = localStorage.getItem(SINGLE_RULES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function syncLateArrivalGraceToggle() {
  if (!el.lateArrivalGraceToggle) return;
  el.lateArrivalGraceToggle.textContent = lateArrivalGraceEnabledState
    ? "Verspätungsregel: Ein"
    : "Verspätungsregel: Aus";
  el.lateArrivalGraceToggle.setAttribute(
    "aria-pressed",
    lateArrivalGraceEnabledState ? "true" : "false",
  );
}

function persistSingleRuleSettings() {
  writeSingleRuleStorage({
    lateArrivalGraceEnabled: lateArrivalGraceEnabledState,
    lateArrivalGraceMinutes: Number(el.lateArrivalGraceMinutes?.value || 45),
  });
}

function restoreSingleRuleSettings() {
  const stored = readSingleRuleStorage();
  lateArrivalGraceEnabledState = Boolean(stored.lateArrivalGraceEnabled);
  if (el.lateArrivalGraceMinutes && stored.lateArrivalGraceMinutes != null) {
    el.lateArrivalGraceMinutes.value = String(stored.lateArrivalGraceMinutes);
  }
  syncLateArrivalGraceToggle();
}

function toTimestamp(value) {
  const date = new Date(String(value || "").trim());
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function sortStopsByDate(stops, sortMode) {
  const items = Array.isArray(stops) ? [...stops] : [];
  const normalizedSortMode = String(sortMode || "arrival-asc").trim();
  if (normalizedSortMode === "status") return sortStopsByStatus(items);
  const fieldMap = {
    "arrival-asc": "arrival_time",
    "arrival-desc": "arrival_time",
    "departure-asc": "departure_time",
    "departure-desc": "departure_time",
    "rule-start-asc": "rule_start_display",
    "rule-start-desc": "rule_start_display",
  };
  const sourceField = fieldMap[normalizedSortMode] || "arrival_time";
  const normalizedDirection = normalizedSortMode.endsWith("desc") ? -1 : 1;

  items.sort((left, right) => {
    const leftTime = toTimestamp(left?.[sourceField]);
    const rightTime = toTimestamp(right?.[sourceField]);

    if (leftTime == null && rightTime == null) return 0;
    if (leftTime == null) return 1;
    if (rightTime == null) return -1;
    if (leftTime === rightTime) return 0;
    return leftTime < rightTime
      ? -1 * normalizedDirection
      : 1 * normalizedDirection;
  });

  return items;
}

// Statussortierung: 1. puenktlich (+abrechenbar zuerst), 2. zu spaet aber
// innerhalb 45 min, 3. 3h-Faelle. Innerhalb jeder Gruppe abrechenbar zuerst,
// dann nach Betrag und Ankunft.
function statusRank(stop) {
  let group = 0; // puenktlich
  if (stop?.late_arrival_grace_applied)
    group = 2; // 3h-Fall
  else if (stop?.arrived_late) group = 1; // zu spaet, innerhalb 45 min
  const chargeable = Number(stop?.amount_eur || 0) > 0 ? 0 : 1;
  return group * 10 + chargeable;
}

function sortStopsByStatus(stops) {
  const items = Array.isArray(stops) ? [...stops] : [];
  items.sort((a, b) => {
    const rankDiff = statusRank(a) - statusRank(b);
    if (rankDiff !== 0) return rankDiff;
    const amountDiff = Number(b?.amount_eur || 0) - Number(a?.amount_eur || 0);
    if (amountDiff !== 0) return amountDiff;
    const at = toTimestamp(a?.arrival_time) ?? Infinity;
    const bt = toTimestamp(b?.arrival_time) ?? Infinity;
    return at - bt;
  });
  return items;
}

function stopDateForFilter(stop) {
  const raw = String(
    stop?.arrival_time ||
      stop?.rule_start_display ||
      stop?.departure_time ||
      stop?.arrival_display ||
      stop?.departure_display ||
      "",
  ).trim();
  const iso = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const de = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return de ? `${de[3]}-${de[2]}-${de[1]}` : "";
}

function dateInRange(stop) {
  const from = el.dateFrom && el.dateFrom.value ? el.dateFrom.value : "";
  const to = el.dateTo && el.dateTo.value ? el.dateTo.value : "";
  if (!from && !to) return true;
  const d = stopDateForFilter(stop);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// Gleiche Transportnummern immer zusammen halten; die Gruppen-Reihenfolge
// folgt dem ersten Vorkommen der jeweiligen Nummer nach der Datumssortierung.
function groupByTransportNumber(stops) {
  const groups = new Map();
  for (const stop of stops) {
    const key = String(stop.transport_number || stop.tour_id || "").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stop);
  }
  return Array.from(groups.values()).flat();
}

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

function euro(value) {
  return Number(value || 0).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

function minutesToHoursChip(value) {
  if (value === null || value === undefined) return "-";
  const total = Math.max(0, Math.round(Number(value)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, "0")} h`;
}

function formatDateTimeForJustification(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return "-";

  const withYear = text.match(/^(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})$/);
  if (withYear) return `${withYear[1].slice(0, 6)} / ${withYear[2]}`;

  const shortDate = text.match(/^(\d{2}\.\d{2})\.?[,]?\s*(\d{2}:\d{2})$/);
  if (shortDate) return `${shortDate[1]}. / ${shortDate[2]}`;

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
  return text;
}

function timeCellHtml(value, toneClass, hint) {
  const text = value || "-";
  const chip = toneClass ? ` time-chip ${toneClass}` : "";
  const suffix =
    hint && text !== "-" ? `<span class="time-hint">${hint}</span>` : "";
  return `<span class="time-stack"><span class="${chip.trim()}">${text}</span>${suffix}</span>`;
}

// Status-Text ohne Prüffall: analog zu den Batch-Gründen.
function singleReasonLabel(stop) {
  if (Number(stop.amount_eur || 0) > 0) return "Abrechenbar";
  const free = Number(stop.free_minutes || 120);
  if (Number(stop.effective_minutes || 0) <= free) return "Innerhalb Freizeit";
  return "Unter Auslöser";
}

function renderStops(stops) {
  const inRange = (Array.isArray(stops) ? stops : []).filter(dateInRange);
  const sortedStops = groupByTransportNumber(
    sortStopsByDate(inRange, el.dateSort.value),
  );
  el.rows.innerHTML = "";
  const selectedKey = activeStop ? stopKey(activeStop) : "";

  for (const stop of sortedStops) {
    const tr = document.createElement("tr");
    const stopKeyValue = stopKey(stop);
    tr.dataset.stopKey = stopKeyValue;
    tr.className = "result-row";
    if (Number(stop.amount_eur || 0) > 0) tr.classList.add("chargeable-row");
    if (stop.needs_review) tr.classList.add("review-row");
    if (stop.window_override_applied) tr.classList.add("fallback-row");
    if (selectedKey && stopKeyValue === selectedKey) {
      tr.classList.add("selected-row");
      tr.setAttribute("aria-current", "true");
    }
    tr.tabIndex = 0;

    const typeUpper = String(stop.type || "").toUpperCase();
    const typeLabel = TYPE_LABELS[typeUpper] || stop.type || "-";
    const gpsVerified = Boolean(stop.gps_verified);
    const srcLabel = gpsVerified ? "GPS" : "XP";
    const srcClass = gpsVerified ? "src-gps" : "src-neutral";
    const boundaryTone = gpsVerified ? "time-chip-gps" : "time-chip-xp";

    const arrivalCell = timeCellHtml(
      formatDateTimeForJustification(stop.arrival_display),
      boundaryTone,
      srcLabel,
    );
    const departureCell = timeCellHtml(
      formatDateTimeForJustification(stop.departure_display),
      boundaryTone,
      srcLabel,
    );

    const windowValue = resolveWindowDisplay(stop);
    const windowTone = stop.window_override_applied
      ? { cls: "time-chip-excel", hint: "Excel" }
      : windowValue !== "-"
        ? { cls: "time-chip-neutral", hint: "Fenster" }
        : { cls: "time-chip-muted", hint: "-" };
    const windowCell = timeCellHtml(
      windowValue,
      windowTone.cls,
      windowTone.hint,
    );

    // Zaehlbeginn: bei Puenktlichkeit gleiche Farbe wie das Zeitfenster,
    // bei Verspaetung rot markiert (auf einen Blick erkennbar).
    const hasWindow = windowValue !== "-";
    const startTone =
      hasWindow && stop.arrived_late
        ? {
            cls: "time-chip-alert",
            hint: stop.late_arrival_grace_applied ? "3h-Regel" : "verspätet",
          }
        : hasWindow
          ? { cls: windowTone.cls, hint: "pünktlich" }
          : { cls: "time-chip-neutral", hint: "Start" };
    const startCell = timeCellHtml(
      formatDateTimeForJustification(stop.rule_start_display),
      startTone.cls,
      startTone.hint,
    );

    const statusLabel = stop.needs_review ? "Prüfen" : singleReasonLabel(stop);

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
    // Manuelle Steuerung: selbst abgerechnete Touren aufnehmen bzw. Status zuruecksetzen.
    const statusActions =
      (!bk.submitted
        ? '<button type="button" class="bk-action" data-action="mark-billed" title="Selbst abgerechnet: in Abgerechnet-Liste aufnehmen">Manuell abgerechnet</button>'
        : "") +
      (bk.submitted || bk.existing || bk.failed
        ? '<button type="button" class="bk-action" data-action="reset" title="Status zurücksetzen">Zurücksetzen</button>'
        : "");
    const submittedCell = `<div class="bk-status">${statusBadge}${statusActions}</div>`;

    tr.innerHTML = `
      <td>${stop.transport_number || stop.tour_id || "-"}</td>
      <td>${escapeHtml(stop.plate || "-")}</td>
      <td>${typeLabel}</td>
      <td>${escapeHtml(stop.booking_location || stop.address || "-")}</td>
      <td><span class="${srcClass}">${srcLabel}</span></td>
      <td>${arrivalCell}</td>
      <td>${departureCell}</td>
      <td>${startCell}</td>
      <td>${windowCell}</td>
      <td>${minutesToHoursChip(stop.counted_standing_minutes)}</td>
      <td>${minutesToHoursChip(stop.billable_minutes)}</td>
      <td>${euro(stop.amount_eur)}</td>
      <td>${stop.billed_units || 0}</td>
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
        persistBookkeepingEntries();
        renderSettled();
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
        persistBookkeepingEntries();
        renderStops();
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
  renderSettled();
}

// Merkt sich die zuletzt angeklickte Tour und hebt ihre Zeile hervor.
function selectStop(stop) {
  activeStop = stop;
  highlightSelectedRow();
  openSurchargeModal(stop);
}

function highlightSelectedRow() {
  if (!el.rows) return;
  const selectedKey = activeStop ? stopKey(activeStop) : "";
  el.rows.querySelectorAll("tr[data-stop-key]").forEach((row) => {
    const isSelected =
      Boolean(selectedKey) && row.dataset.stopKey === selectedKey;
    row.classList.toggle("selected-row", isSelected);
    if (isSelected) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  });
}

function buildSettledStops() {
  const list = [];
  for (const stop of latestStops || []) {
    const entry = getBookkeepingEntry(stop);
    if (entry && entry.billed) list.push(stop);
  }
  return list;
}

function settledStationLabel(stop) {
  const type = String(stop.type || "").toLowerCase();
  if (type === "unloading") return "Entladestelle";
  if (type === "loading") return "Beladestelle";
  return "-";
}

function renderSettled() {
  if (!el.settledRows) return;
  const stops = buildSettledStops();
  el.settledRows.innerHTML = "";

  let sum = 0;
  for (const stop of stops) {
    sum += Number(stop.amount_eur || 0);
    const entryForRow = getBookkeepingEntry(stop);
    const tr = document.createElement("tr");
    tr.className = "result-row";
    tr.innerHTML = `
      <td>${stop.transport_number || stop.tour_id || "-"}</td>
      <td>${stop.type || "-"}</td>
      <td>${stop.booking_location || stop.address || "-"}</td>
      <td>${settledStationLabel(stop)}</td>
      <td>${resolveWindowDisplay(stop)}</td>
      <td>${formatMinutesAsHours(stop.effective_minutes)}</td>
      <td>${Number(stop.amount_eur || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" })}</td>
      <td><span class="tp-done">✓ Abgerechnet${entryForRow.manual ? " (manuell)" : ""}</span></td>
    `;
    tr.addEventListener("click", () => openSurchargeModal(stop));
    el.settledRows.appendChild(tr);
  }

  if (el.settledCount) el.settledCount.textContent = String(stops.length);
  if (el.settledSum) {
    el.settledSum.textContent = sum.toLocaleString("de-DE", {
      style: "currency",
      currency: "EUR",
    });
  }
}

function switchResultTab(tab) {
  const showSettled = tab === "settled";
  if (el.settledView) el.settledView.hidden = !showSettled;
  if (el.allView) el.allView.hidden = showSettled;
  if (el.tabSettled) el.tabSettled.classList.toggle("active", showSettled);
  if (el.tabAll) el.tabAll.classList.toggle("active", !showSettled);
  if (showSettled) renderSettled();
}

async function exportSettled() {
  const stops = buildSettledStops();
  if (!stops.length) {
    setStatus("Keine abgerechneten Touren zum Exportieren.", "error");
    return;
  }

  const rows = stops.map((stop) => ({
    transport_number: String(stop.transport_number || "").trim(),
    amount_eur: Number(stop.amount_eur || 0),
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

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toCellText(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
  return String(value ?? "").trim();
}

function pickColumn(headerList, patterns) {
  for (const header of headerList) {
    const normalized = normalizeHeader(header);
    if (patterns.some((regex) => regex.test(normalized))) {
      return header;
    }
  }
  return "";
}

function isTimeLike(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return true;
  if (/^\d{1,2}\.\d{2}$/.test(text)) return true;
  if (/^0[\.,]\d+$/.test(text)) return true;
  if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(text)) return true;
  return false;
}

function excelFractionToHm(value) {
  const raw = String(value || "")
    .trim()
    .replace(",", ".");
  if (!/^0\.\d+$/.test(raw)) return "";

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return "";

  const totalMinutes = Math.round(numeric * 24 * 60);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalizeSingleTimeToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{1,2}\.\d{2}$/.test(text)) return text.replace(".", ":");
  const frac = excelFractionToHm(text);
  if (frac) return frac;
  if (/^\d{1,2}:\d{2}$/.test(text)) return text;
  return "";
}

function normalizeTimeValue(value) {
  const text = String(value || "").trim();
  if (!text) return { start: "", end: "" };

  const rangeMatch = text.match(
    /^(\d{1,2}(?::|\.)\d{2}|0[\.,]\d+)\s*-\s*(\d{1,2}(?::|\.)\d{2}|0[\.,]\d+)$/,
  );
  if (rangeMatch) {
    const start = normalizeSingleTimeToken(String(rangeMatch[1] || ""));
    const end = normalizeSingleTimeToken(String(rangeMatch[2] || ""));
    return { start, end };
  }

  const single = normalizeSingleTimeToken(text);
  return { start: single, end: "" };
}

function looksLikeKey(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (isTimeLike(text)) return false;
  if (/^\d{4,}$/.test(text)) return true;
  if (/^[A-Za-z0-9_-]{4,}$/.test(text)) return true;
  return false;
}

function chooseFallbackKeyColumn(headers, rows) {
  let bestHeader = "";
  let bestScore = -1;

  headers.forEach((header, index) => {
    const values = rows.map((row) => toCellText(row[header])).filter(Boolean);
    if (!values.length) return;

    const valid = values.filter((value) => looksLikeKey(value));
    const unique = new Set(valid);
    const duplicates = Math.max(0, valid.length - unique.size);
    let score = valid.length * 2 + duplicates;

    if (index >= Math.floor(headers.length / 2)) score += 1;
    if (/nummer|nr|tour|route|transport|trip/i.test(normalizeHeader(header))) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestHeader = header;
    }
  });

  return bestScore >= 3 ? bestHeader : "";
}

function chooseBestIdColumn(headers, rows) {
  const candidates = headers.filter((header) => {
    const h = normalizeHeader(header);
    return /(cola|transport|tour|ladenumm|nummer|nr|route|trip)/.test(h);
  });
  if (!candidates.length) return "";

  let best = "";
  let bestScore = -1;

  for (const header of candidates) {
    const values = rows.map((row) => toCellText(row[header])).filter(Boolean);
    if (!values.length) continue;

    const last7Hits = values.filter((value) =>
      /\d{7}$/.test(value.replace(/\D/g, "")),
    ).length;
    const numericHits = values.filter((value) =>
      /^\d{6,10}$/.test(value.replace(/\D/g, "")),
    ).length;
    const uniqueCount = new Set(values).size;
    const duplicateBonus = Math.max(0, values.length - uniqueCount);
    const headerBonus = /(cola|transport|tour|ladenumm)/.test(
      normalizeHeader(header),
    )
      ? 3
      : 0;

    const score =
      last7Hits * 4 + numericHits * 2 + duplicateBonus + headerBonus;
    if (score > bestScore) {
      best = header;
      bestScore = score;
    }
  }

  return best;
}

function chooseFallbackTimeColumns(headers, rows) {
  const scored = headers
    .map((header, index) => {
      const count = rows
        .map((row) => toCellText(row[header]))
        .filter((value) => isTimeLike(value)).length;
      return { header, index, count };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.index - b.index;
    });

  return scored.slice(0, 2).map((entry) => entry.header);
}

function inferTypeFromRow(row) {
  const values = Object.values(row || {})
    .map((value) => normalizeHeader(toCellText(value)))
    .filter(Boolean)
    .join(" ");
  if (/entlad|ablad|unload/.test(values)) return "UNLOAD";
  if (/belad|ladung|load/.test(values)) return "LOAD";
  return "";
}

function buildLocationFallback(headers, row, excludedHeaders) {
  const excluded = new Set(excludedHeaders.filter(Boolean));
  const textCells = headers
    .filter((header) => !excluded.has(header))
    .map((header) => toCellText(row[header]))
    .filter((text) => {
      if (!text) return false;
      if (isTimeLike(text)) return false;
      if (looksLikeKey(text)) return false;
      return /[A-Za-zAeOeUeaeoeue]/.test(text);
    });

  return textCells.slice(0, 2).join(" - ");
}

function buildTimeWindowsFallback(rows, headers, keyCol) {
  const timeCols = chooseFallbackTimeColumns(headers, rows);
  if (!keyCol || timeCols.length < 1) return [];

  const groupedRows = new Map();
  for (const row of rows) {
    const key = toCellText(row[keyCol]);
    if (!looksLikeKey(key)) continue;
    if (!groupedRows.has(key)) groupedRows.set(key, []);
    groupedRows.get(key).push(row);
  }

  const windows = [];
  for (const [key, groupRows] of groupedRows.entries()) {
    groupRows.forEach((row, index) => {
      const first = normalizeTimeValue(toCellText(row[timeCols[0]]));
      const second = timeCols[1]
        ? normalizeTimeValue(toCellText(row[timeCols[1]]))
        : { start: "", end: "" };

      const windowStart = first.start || second.start || "";
      const windowEnd = second.start || first.end || second.end || "";
      if (!windowStart && !windowEnd) return;

      const explicitType = inferTypeFromRow(row);
      const fallbackType =
        groupRows.length >= 2
          ? index === 0
            ? "LOAD"
            : index === 1
              ? "UNLOAD"
              : "ANY"
          : "ANY";

      const location = buildLocationFallback(headers, row, [
        keyCol,
        ...timeCols,
      ]);

      windows.push({
        route_key: key,
        transport_number: key,
        tour_id: key,
        stop_type: explicitType || fallbackType,
        location: location || null,
        window_start: windowStart || null,
        window_end: windowEnd || null,
      });
    });
  }

  return windows;
}

function buildTimeWindowsFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { windows: [], message: "Datei hat keine Zeilen." };
  }

  const headers = Object.keys(rows[0] || {});
  const keyCol = pickColumn(headers, [
    /tour/,
    /transport/,
    /sendung/,
    /route/,
    /trip/,
    /nummer/,
    /\bnr\b/,
  ]);
  const colaCol = pickColumn(headers, [
    /cola/,
    /coca/,
    /ccep/,
    /cola.*(nr|nummer)/,
  ]);
  const transportNumberCol = pickColumn(headers, [
    /transport.*(nr|nummer|number)/,
    /sendung.*(nr|nummer|number)/,
    /shipment.*(nr|nummer|number)/,
  ]);
  const tourIdCol = pickColumn(headers, [
    /tour.*(nr|nummer|id)/,
    /route.*(nr|nummer|id)/,
    /trip.*(nr|nummer|id)/,
  ]);
  const ladenummerCol = pickColumn(headers, [
    /ladenummer/,
    /lade.*(nr|nummer)/,
    /loading.*(nr|number)/,
  ]);
  const bestIdCol = chooseBestIdColumn(headers, rows);

  const loadLocationCol = pickColumn(headers, [
    /ladestelle/,
    /ladeort/,
    /beladestelle/,
    /beladeort/,
  ]);
  const unloadLocationCol = pickColumn(headers, [
    /entladestelle/,
    /entladeort/,
    /abladestelle/,
    /abladeort/,
    /ziel/,
  ]);
  const typeCol = pickColumn(headers, [
    /typ/,
    /type/,
    /ladung/,
    /entladung/,
    /stop/,
  ]);
  const locationCol = pickColumn(headers, [
    /ort/,
    /location/,
    /ziel/,
    /kunde/,
    /standort/,
    /rampe/,
    /gate/,
  ]);

  const loadStartCol = pickColumn(headers, [
    /^ladezeit$/,
    /lade.*(von|start|beginn)/,
    /belad.*(von|start|beginn)/,
  ]);
  const loadEndCol = pickColumn(headers, [
    /^ladezeit bis$/,
    /lade.*(bis|ende)/,
    /belad.*(bis|ende)/,
  ]);
  const unloadStartCol = pickColumn(headers, [
    /^entladezeit$/,
    /entlad.*(von|start|beginn)/,
    /ablad.*(von|start|beginn)/,
  ]);
  const unloadEndCol = pickColumn(headers, [
    /^entladezeit bis$/,
    /entlad.*(bis|ende)/,
    /ablad.*(bis|ende)/,
  ]);

  const genericStartCol = pickColumn(headers, [
    /zeitfenster.*(von|start|beginn)/,
    /\bstart\b/,
    /\bbeginn\b/,
  ]);
  const genericEndCol = pickColumn(headers, [
    /zeitfenster.*(bis|ende)/,
    /\bbis\b/,
    /\bende\b/,
  ]);

  const windows = [];
  for (const row of rows) {
    const colaNumber = toCellText(row[colaCol]);
    const transportNumber = toCellText(row[transportNumberCol]);
    const tourId = toCellText(row[tourIdCol]);
    const loadNumber = toCellText(row[ladenummerCol]);
    const smartId = toCellText(row[bestIdCol]);
    const key =
      colaNumber ||
      transportNumber ||
      tourId ||
      smartId ||
      loadNumber ||
      toCellText(row[keyCol]);
    if (!key) continue;

    const genericLocation = toCellText(row[locationCol]);
    const loadLocation = toCellText(row[loadLocationCol]) || genericLocation;
    const unloadLocation =
      toCellText(row[unloadLocationCol]) || genericLocation;
    const rowType = toCellText(row[typeCol]).toUpperCase();

    const loadStart = toCellText(row[loadStartCol]);
    const loadEnd = toCellText(row[loadEndCol]);
    if (loadStart || loadEnd) {
      windows.push({
        route_key: key,
        cola_number: colaNumber || null,
        transport_number: transportNumber || smartId || key || null,
        tour_id: tourId || transportNumber || smartId || key || null,
        load_number: loadNumber || null,
        stop_type: "LOAD",
        location: loadLocation || null,
        window_start: loadStart || null,
        window_end: loadEnd || null,
      });
    }

    const unloadStart = toCellText(row[unloadStartCol]);
    const unloadEnd = toCellText(row[unloadEndCol]);
    if (unloadStart || unloadEnd) {
      windows.push({
        route_key: key,
        cola_number: colaNumber || null,
        transport_number: transportNumber || smartId || key || null,
        tour_id: tourId || transportNumber || smartId || key || null,
        load_number: loadNumber || null,
        stop_type: "UNLOAD",
        location: unloadLocation || null,
        window_start: unloadStart || null,
        window_end: unloadEnd || null,
      });
    }

    const genericStart = toCellText(row[genericStartCol]);
    const genericEnd = toCellText(row[genericEndCol]);
    const hasSpecific = loadStart || loadEnd || unloadStart || unloadEnd;
    if (!hasSpecific && (genericStart || genericEnd)) {
      windows.push({
        route_key: key,
        cola_number: colaNumber || null,
        transport_number: transportNumber || smartId || key || null,
        tour_id: tourId || transportNumber || smartId || key || null,
        load_number: loadNumber || null,
        stop_type: rowType === "LOAD" || rowType === "UNLOAD" ? rowType : "ANY",
        location: genericLocation || null,
        window_start: genericStart || null,
        window_end: genericEnd || null,
      });
    }
  }

  if (!windows.length) {
    const fallbackKeyCol = keyCol || chooseFallbackKeyColumn(headers, rows);
    const fallbackWindows = buildTimeWindowsFallback(
      rows,
      headers,
      fallbackKeyCol,
    );
    return {
      windows: fallbackWindows,
      message: fallbackWindows.length
        ? `Fallback aktiv. ID-Spalte: ${fallbackKeyCol || "unbekannt"}`
        : "Keine ID-/Zeitspalten erkannt.",
    };
  }

  return {
    windows,
    message:
      keyCol || bestIdCol
        ? `ID-Spalte erkannt: ${colaCol || bestIdCol || keyCol}${ladenummerCol ? ` (Ladenummer: ${ladenummerCol})` : ""}`
        : "Keine ID-Spalte erkannt.",
  };
}

async function importTimeWindowsFromExcel() {
  const file = el.timeWindowFile.files?.[0] || null;
  if (!file) throw new Error("Bitte zuerst eine Excel-Datei auswaehlen.");
  if (!window.XLSX)
    throw new Error("Excel-Bibliothek konnte nicht geladen werden.");

  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName)
    throw new Error("Excel-Datei enthaelt kein Tabellenblatt.");

  const sheet = workbook.Sheets[firstSheetName];
  const rows = window.XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });

  const parsed = buildTimeWindowsFromRows(rows);
  if (!parsed.windows.length) {
    importedTimeWindows = [];
    el.timeWindowMeta.textContent = "Keine Zeitfenster importiert.";
    throw new Error(
      "Excel eingelesen, aber keine nutzbaren Zeitfenster gefunden.",
    );
  }

  importedTimeWindows = parsed.windows;
  el.timeWindowMeta.textContent = `Zeitfenster importiert: ${parsed.windows.length} Zeilen.`;
  return parsed;
}

function clearTimeWindows() {
  importedTimeWindows = [];
  el.timeWindowFile.value = "";
  el.timeWindowMeta.textContent = "Keine Zeitfenster importiert.";
}

function loadPersistedUrl() {
  try {
    const savedUrl = localStorage.getItem(URL_STORAGE_KEY);
    if (savedUrl && !String(el.url.value || "").trim()) {
      el.url.value = savedUrl;
    }
  } catch (_error) {
    // localStorage kann in manchen Browser-Kontexten blockiert sein.
  }
}

function loadPersistedSessionToken() {
  try {
    const savedToken = localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (savedToken && !String(el.sessionToken.value || "").trim()) {
      el.sessionToken.value = savedToken;
    }
  } catch (_error) {
    // localStorage kann in manchen Browser-Kontexten blockiert sein.
  }
}

function persistUrl(urlValue) {
  try {
    localStorage.setItem(URL_STORAGE_KEY, String(urlValue || "").trim());
  } catch (_error) {
    // Fallback: Wenn Speichern fehlschlaegt, laeuft die App normal weiter.
  }
}

function persistSessionToken(tokenValue) {
  try {
    localStorage.setItem(
      SESSION_TOKEN_STORAGE_KEY,
      String(tokenValue || "").trim(),
    );
  } catch (_error) {
    // Fallback: Wenn Speichern fehlschlaegt, laeuft die App normal weiter.
  }
}

function compactDateTimeDisplay(value) {
  const text = String(value || "-").trim();
  if (!text || text === "-") return "-";
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}:\d{2})$/);
  if (!match) return text;
  return `${match[1]}.${match[2]} ${match[4]}`;
}

function compactWindowDisplay(startValue, endValue) {
  const start = compactDateTimeDisplay(startValue);
  const end = compactDateTimeDisplay(endValue);
  if (start === "-" && end === "-") return "-";
  if (end === "-") return start;
  if (start === "-") return end;
  return `${start} - ${end}`;
}

function compactSingleWindowValue(startValue, endValue) {
  const start = compactDateTimeDisplay(startValue);
  const end = compactDateTimeDisplay(endValue);
  if (start !== "-") return start;
  if (end !== "-") return end;
  return "-";
}

function detailCell(text) {
  return text || "-";
}

function detailRowHtml(field, xp, gps, used) {
  const valueXp = detailCell(xp);
  const valueGps = detailCell(gps);
  const valueUsed = detailCell(used);
  return `
    <tr>
      <td>${field}</td>
      <td>${valueXp}</td>
      <td>${valueGps}</td>
      <td class="detail-used">${valueUsed}</td>
    </tr>
  `;
}

// Zeitfenster als eigene Leiste (eine Zeile mit Status-Badge), wie im Batch-Popup.
function buildWindowStatus(stop) {
  const hasWindow = resolveWindowDisplay(stop) !== "-";
  if (!hasWindow) {
    return { className: "detail-window-missing", text: "Kein Zeitfenster" };
  }
  if (stop?.arrived_late) {
    return {
      className: "detail-window-late",
      text: stop.late_arrival_grace_applied
        ? "Verspätet · 3h-Regel"
        : "Verspätet",
    };
  }
  return { className: "detail-window-hit", text: "Pünktlich" };
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

function detailFallbackStatusRowHtml(stop) {
  const typeUpper = String(stop?.type || "").toUpperCase();
  if (typeUpper !== "UNLOADING") return "";

  const replaced = Boolean(stop?.window_override_applied);
  const hasWindow = resolveWindowDisplay(stop) !== "-";

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

function excelSingleWindowValue(stop) {
  const raw = String(stop?.excel_window_display || "").trim();
  if (!raw) return "-";
  if (/^\d{1,2}\.\d{2}$/.test(raw)) return raw.replace(".", ":");
  if (/^\d{1,2}:\d{2}$/.test(raw)) return raw;
  const compact = compactDateTimeDisplay(raw);
  return compact || raw;
}

function resolveWindowDisplay(stop) {
  const fromSlots = compactSingleWindowValue(
    stop?.slot_begin_display,
    stop?.slot_end_display,
  );
  if (fromSlots !== "-") return fromSlots;
  return excelSingleWindowValue(stop);
}

function getTimeWindowSource(stop) {
  if (stop?.window_override_applied) {
    return { label: "Excel", className: "source-excel" };
  }
  if (
    String(stop?.timeslot_begin || "").trim() ||
    String(stop?.timeslot_end || "").trim()
  ) {
    return { label: "Sixfold", className: "source-sixfold" };
  }
  return { label: "Keine", className: "source-none" };
}

function getTrackingState(stop) {
  const stopStatus = String(stop?.status || "")
    .trim()
    .toLowerCase();
  const tourStatus = String(stop?.tour_status || "")
    .trim()
    .toLowerCase();
  const combined = `${tourStatus} ${stopStatus}`;

  if (/(cancel|abort|abbruch|failed|error)/.test(combined)) {
    return { label: "Abgebrochen", className: "tracking-aborted" };
  }
  if (/(departed|delivered|finished|completed|visited|done)/.test(combined)) {
    return { label: "Durchgelaufen", className: "tracking-done" };
  }
  if (
    /(arrived|loading|unloading|in_transit|ongoing|active|en_route)/.test(
      combined,
    )
  ) {
    return { label: "Aktiv", className: "tracking-active" };
  }
  if (
    /(planned|unvisited|created|pending|unassigned|unallocated)/.test(combined)
  ) {
    return { label: "Offen", className: "tracking-open" };
  }
  return { label: "Unklar", className: "tracking-unknown" };
}

function formatMinutesAsHours(minutesValue) {
  const totalMinutes = Math.max(0, Number(minutesValue || 0));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatDateTimeForText(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return "-";

  const withYear = text.match(/^(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})$/);
  if (withYear) return `${withYear[1].slice(0, 6)} / ${withYear[2]}`;

  const shortDate = text.match(/^(\d{2}\.\d{2})\.?[,]?\s*(\d{2}:\d{2})$/);
  if (shortDate) return `${shortDate[1]}. / ${shortDate[2]}`;

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

  return text;
}

function resolveWindowTextForSurcharge(stop) {
  const slotText = formatDateTimeForText(stop?.slot_begin_display);
  if (slotText !== "-") return slotText;

  const excelRaw = String(stop?.excel_window_display || "").trim();
  if (excelRaw) {
    if (/^\d{1,2}\.\d{2}$/.test(excelRaw)) return excelRaw.replace(".", ":");
    if (/^\d{1,2}:\d{2}$/.test(excelRaw)) return excelRaw;
    return formatDateTimeForText(excelRaw);
  }

  return resolveWindowDisplay(stop);
}

function buildSurchargeDescription(stop) {
  const arrival = formatDateTimeForText(
    stop.arrival_time || stop.arrival_display,
  );
  const departure = formatDateTimeForText(
    stop.departure_time || stop.departure_display,
  );
  const windowText = resolveWindowTextForSurcharge(stop);
  const counted = formatMinutesAsHours(stop.counted_standing_minutes);
  const billable = formatMinutesAsHours(stop.billable_minutes);

  return [
    `Zeitfenster: ${windowText}`,
    `Ankunft: ${arrival}`,
    `Abfahrt: ${departure}`,
    `Standzeit: ${counted}`,
    `Abzurechnende Standzeit: ${billable}`,
  ].join("\n");
}

function openSurchargeModal(stop) {
  const transportId = String(
    stop.transport_number || stop.tour_id || "",
  ).trim();
  const typeUpper = String(stop.type || "").toUpperCase();
  const typeLabel = TYPE_LABELS[typeUpper] || stop.type || "-";
  el.surchargeTitle.textContent = `${transportId || "-"} · ${typeLabel}`;
  const arrival = compactDateTimeDisplay(stop.arrival_display);
  const departure = compactDateTimeDisplay(stop.departure_display);
  const countStart = compactDateTimeDisplay(stop.rule_start_display);
  const countStartUsed =
    countStart === "-"
      ? "-"
      : `<span class="time-chip ${stop.arrived_late ? "time-chip-alert" : "time-chip-match"}">${countStart}</span>`;
  const windowText = resolveWindowDisplay(stop);
  const effective = formatMinutesAsHours(stop.effective_minutes);
  const counted = formatMinutesAsHours(stop.counted_standing_minutes);
  const billable = formatMinutesAsHours(stop.billable_minutes);
  const freeWindow = formatMinutesAsHours(
    stop.free_minutes || el.freeMinutes.value || 120,
  );
  const amount = euro(stop.amount_eur);

  if (el.surchargeMeta) {
    el.surchargeMeta.textContent = "";
    el.surchargeMeta.hidden = true;
  }
  if (el.surchargeDetailRows) {
    el.surchargeDetailRows.innerHTML =
      detailWindowRowHtml(windowText, buildWindowStatus(stop)) +
      detailRowHtml("Ankunft", arrival, "-", countStartUsed) +
      detailRowHtml("Abfahrt", departure, "-", departure) +
      detailRowHtml("Standzeit (Ist)", effective, "-", effective) +
      detailRowHtml(
        "Standzeit ab Zählbeginn",
        "-",
        "-",
        `${counted}${stop.late_arrival_grace_applied ? " · 3h-Regel" : ""}`,
      ) +
      detailRowHtml("Freigrenze", "-", "-", freeWindow) +
      detailRowHtml("Über Frei", "-", "-", billable) +
      detailFallbackStatusRowHtml(stop) +
      detailTotalRowHtml(amount);
  }
  el.surchargeText.value = buildSurchargeDescription(stop);
  el.surchargeModal.hidden = false;
}

function closeSurchargeModal() {
  el.surchargeModal.hidden = true;
}

async function run() {
  const resolvedUrl = String(el.url.value || "").trim();
  const resolvedSessionToken = String(el.sessionToken.value || "").trim();
  persistUrl(resolvedUrl);
  persistSessionToken(resolvedSessionToken);

  const body = {
    url: resolvedUrl,
    period: String(el.periodMode.value || "day").trim(),
    referenceDate: String(el.referenceDate.value || "").trim(),
    fromDate: String(el.rangeFrom.value || "").trim(),
    toDate: String(el.rangeTo.value || "").trim(),
    transportNumber: String(el.transportNumber.value || "").trim(),
    tourId: String(el.tourId.value || "").trim(),
    sessionToken: resolvedSessionToken,
    rules: {
      freeMinutes: Number(el.freeMinutes.value || 120),
      intervalMinutes: Number(el.unitMinutes.value || 30),
      unitPrice: Number(el.unitPrice.value || 30),
      thresholdEur: Number(el.thresholdEur.value || 30),
      capEur: Number(el.capEur.value || 650),
      lateArrivalGraceEnabled: lateArrivalGraceEnabledState,
      lateArrivalGraceMinutes: Number(el.lateArrivalGraceMinutes.value || 45),
    },
    timeWindows: importedTimeWindows,
  };

  el.runBtn.disabled = true;
  setStatus("Berechne...");

  try {
    const res = await fetch("/api/sixfold/standgeld", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Fehler bei der Berechnung.");

    el.resultPanel.hidden = false;
    el.amount.textContent = data.summary?.amount_display || "-";
    el.positions.textContent = String(data.summary?.billed_positions || 0);
    el.units.textContent = String(data.summary?.units || 0);
    latestStops = Array.isArray(data.stops) ? data.stops : [];
    restoreBookkeepingEntries(latestStops);
    ensureBookkeepingEntries(latestStops);
    renderStops(latestStops);

    setStatus("Berechnung erfolgreich.", "success");
  } catch (error) {
    setStatus(error.message || "Fehler beim Berechnen.", "error");
  } finally {
    el.runBtn.disabled = false;
  }
}

el.importTimeWindowBtn.addEventListener("click", async () => {
  try {
    setStatus("Lese Excel...");
    const parsed = await importTimeWindowsFromExcel();
    setStatus(`Excel-Import erfolgreich. ${parsed.message}`, "success");
  } catch (error) {
    setStatus(error.message || "Fehler beim Excel-Import.", "error");
  }
});

el.clearTimeWindowBtn.addEventListener("click", () => {
  clearTimeWindows();
  setStatus("Zeitfenster zurückgesetzt.", "success");
});

el.dateSort.addEventListener("change", () => {
  renderStops(latestStops);
});

if (el.dateFrom) {
  el.dateFrom.addEventListener("change", () => renderStops(latestStops));
}
if (el.dateTo) {
  el.dateTo.addEventListener("change", () => renderStops(latestStops));
}
if (el.dateClearBtn) {
  el.dateClearBtn.addEventListener("click", () => {
    if (el.dateFrom) el.dateFrom.value = "";
    if (el.dateTo) el.dateTo.value = "";
    renderStops(latestStops);
  });
}

el.copySurchargeBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(String(el.surchargeText.value || ""));
    setStatus("Zuschlagstext kopiert.", "success");
  } catch (_error) {
    setStatus("Kopieren nicht möglich. Bitte Text manuell kopieren.", "error");
  }
});

el.closeSurchargeModalBtn.addEventListener("click", closeSurchargeModal);
el.closeSurchargeModalBtn2.addEventListener("click", closeSurchargeModal);

el.surchargeModal.addEventListener("click", (event) => {
  if (event.target === el.surchargeModal) {
    closeSurchargeModal();
  }
});

el.url.addEventListener("change", () => {
  persistUrl(el.url.value);
});

el.sessionToken.addEventListener("change", () => {
  persistSessionToken(el.sessionToken.value);
});

loadPersistedUrl();
loadPersistedSessionToken();
restoreSingleRuleSettings();

if (el.lateArrivalGraceToggle) {
  el.lateArrivalGraceToggle.addEventListener("click", () => {
    lateArrivalGraceEnabledState = !lateArrivalGraceEnabledState;
    syncLateArrivalGraceToggle();
    persistSingleRuleSettings();
  });
}

if (el.lateArrivalGraceMinutes) {
  el.lateArrivalGraceMinutes.addEventListener(
    "input",
    persistSingleRuleSettings,
  );
  el.lateArrivalGraceMinutes.addEventListener(
    "change",
    persistSingleRuleSettings,
  );
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

if (el.tabAll) {
  el.tabAll.addEventListener("click", () => switchResultTab("all"));
}
if (el.tabSettled) {
  el.tabSettled.addEventListener("click", () => switchResultTab("settled"));
}
if (el.settledExportBtn) {
  el.settledExportBtn.addEventListener("click", exportSettled);
}

el.runBtn.addEventListener("click", run);
