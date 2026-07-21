"use strict";

const el = {
  freeMinutes: document.getElementById("freeMinutes"),
  blockMinutes: document.getElementById("blockMinutes"),
  blockRateEur: document.getElementById("blockRateEur"),
  triggerMinutes: document.getElementById("triggerMinutes"),
  loadBtn: document.getElementById("loadBtn"),
  fileInput: document.getElementById("fileInput"),
  uploadBtn: document.getElementById("uploadBtn"),
  sixfoldUrl: document.getElementById("sixfoldUrl"),
  sixfoldToken: document.getElementById("sixfoldToken"),
  sixfoldDateFrom: document.getElementById("sixfoldDateFrom"),
  sixfoldDateTo: document.getElementById("sixfoldDateTo"),
  applyDateFilter: document.getElementById("applyDateFilter"),
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
  rows: document.getElementById("rows"),
  stopDetailModal: document.getElementById("stopDetailModal"),
  stopDetailTitle: document.getElementById("stopDetailTitle"),
  stopDetailMeta: document.getElementById("stopDetailMeta"),
  stopDetailRows: document.getElementById("stopDetailRows"),
  closeStopDetailModalBtn: document.getElementById("closeStopDetailModalBtn"),
  closeStopDetailModalBtn2: document.getElementById("closeStopDetailModalBtn2"),
};

let currentStops = [];

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

function openStopDetailModal(stop) {
  if (!el.stopDetailModal || !stop) return;

  const typeLabel = TYPE_LABELS[stop.stop_type] || stop.stop_type || "-";
  el.stopDetailTitle.textContent = `${stop.transport_number || "-"} · ${typeLabel}`;

  const source = sourceLabel(stop);
  const kfz = plateCheckLabel(stop);
  const usedStanding = minutesToHours(
    standingMinutesFromIso(stop.arrival_time_used, stop.departure_time_used) ??
      stop.counted_standing_minutes,
  );
  el.stopDetailMeta.textContent = `Quelle: ${source} · KFZ: ${kfz} · Genutzte Standzeit: ${usedStanding}`;

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
    detailRowHtml("Standzeit", xpStanding, gpsStanding, usedStanding);

  el.stopDetailModal.hidden = false;
}

function closeStopDetailModal() {
  if (!el.stopDetailModal) return;
  el.stopDetailModal.hidden = true;
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

    tr.innerHTML = `
      <td>${stop.transport_number || "-"}</td>
      <td>${TYPE_LABELS[stop.stop_type] || stop.stop_type || "-"}</td>
      <td>${stop.window_local || "-"}</td>
      <td>${stop.arrival_local || "-"}</td>
      <td>${stop.departure_local || "-"}</td>
      <td><span class="${srcClass}">${src}</span></td>
      <td>${plateCheckLabel(stop)}</td>
      <td>${isoToLocal(stop.count_start)}</td>
      <td>${minutesToHours(stop.counted_standing_minutes)}</td>
      <td>${minutesToHours(stop.minutes_over_free)}</td>
      <td>${stop.billable_blocks || 0}</td>
      <td>${euro(stop.fee_eur)}</td>
      <td>${statusLabel}</td>
    `;
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
  return new URLSearchParams({
    freeMinutes: el.freeMinutes.value,
    blockMinutes: el.blockMinutes.value,
    blockRateEur: el.blockRateEur.value,
    triggerMinutes: el.triggerMinutes.value,
  });
}

function applyResult(data) {
  currentStops = data.stops || [];
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
  setStatus(
    `${data.summary.transport_count} Transporte · ${data.summary.stop_count} Positionen${gpsNote}.`,
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
  // Füge Datums-Filter als Query-Parameter hinzu (für Sixfold-API)
  const params = new URLSearchParams();
  const dateFrom = (el.sixfoldDateFrom.value || "").trim();
  const dateTo = (el.sixfoldDateTo.value || "").trim();
  if (dateFrom) params.set("sixfoldDateFrom", dateFrom);
  if (dateTo) params.set("sixfoldDateTo", dateTo);
  return params.toString() ? `&${params.toString()}` : "";
}

async function load() {
  const gps = sixfoldHeaders();
  const hasGps = Boolean(gps["x-sixfold-url"]);
  setStatus(hasGps ? "Lade Transporte + GPS-Abgleich …" : "Lade Transporte …");
  el.loadBtn.disabled = true;

  try {
    const baseUrl = `/api/billing/export?${ruleParams().toString()}`;
    const url = baseUrl + sixfoldParams();
    const res = await fetch(url, {
      headers: gps,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    applyResult(data);
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
      setStatus(`Lade „${file.name}" hoch, gleiche GPS ab und rechne ab …`);
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    applyResult(data);
  } catch (error) {
    setStatus(error.message || "Fehler beim Hochladen", "error");
  } finally {
    el.uploadBtn.disabled = false;
    el.loadBtn.disabled = false;
  }
}

el.loadBtn.addEventListener("click", load);
el.uploadBtn.addEventListener("click", upload);
el.fileInput.addEventListener("change", () => {
  el.uploadBtn.disabled = !(el.fileInput.files && el.fileInput.files.length);
});
el.filterMode.addEventListener("change", render);
if (el.closeStopDetailModalBtn) {
  el.closeStopDetailModalBtn.addEventListener("click", closeStopDetailModal);
}
if (el.closeStopDetailModalBtn2) {
  el.closeStopDetailModalBtn2.addEventListener("click", closeStopDetailModal);
}
if (el.stopDetailModal) {
  el.stopDetailModal.addEventListener("click", (event) => {
    if (event.target === el.stopDetailModal) closeStopDetailModal();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeStopDetailModal();
});

// Beim Öffnen direkt laden.
load();
