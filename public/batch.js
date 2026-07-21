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
  const countedStanding = minutesToHours(stop.counted_standing_minutes);
  const freeStanding = minutesToHours(stop.minutes_over_free);
  const windowLocal = stop.window_local || "-";
  const countStartLocal = isoToLocal(stop.count_start);
  const rebookingNote = stop.rebooking_suspected
    ? " · ⚠ Umbuchung/Pause erkannt: gezählt ab GPS-Ankunft (Prüffall)"
    : "";
  el.stopDetailMeta.textContent =
    `Zeitfenster: ${windowLocal} · Zählbeginn: ${countStartLocal} · ` +
    `Quelle: ${source} · KFZ: ${kfz} · Ist-Standzeit: ${usedStanding} · ` +
    `Ab Zählbeginn: ${countedStanding} · 2h frei: ${freeStanding}` +
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
    detailRowHtml("2h frei", "-", "-", freeStanding);

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
  const filterNote = data.summary.date_filter_applied
    ? ` · Datumsfilter: ${data.summary.filtered_transport_count}/${data.summary.input_transport_count} Transporte (ausgeschlossen: ${data.summary.excluded_transport_count})`
    : "";
  const mixNote =
    typeof data.summary.mixed_source_count === "number"
      ? ` · Mix-Stopps: ${data.summary.mixed_source_count}`
      : "";
  setStatus(
    `${data.summary.transport_count} Transporte · ${data.summary.stop_count} Positionen${gpsNote}${filterNote}${mixNote}.`,
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
  // Keine Datums-Filter mehr (Filterung erfolgt in Transporeon)
  return "";
}

async function load() {
  const gps = sixfoldHeaders();
  const hasGps = Boolean(gps["x-sixfold-url"]);
  setStatus(
    hasGps
      ? "Lade Transporte aus Event Management + GPS-Abgleich …"
      : "Lade Transporte aus Event Management …",
  );
  el.loadBtn.disabled = true;

  try {
    const baseUrl = `/api/billing/live?${ruleParams().toString()}`;
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
    const baseUrl = `/api/billing/live-upload?${params.toString()}`;
    const url = baseUrl + sixfoldParams();
    if (gps["x-sixfold-url"]) {
      setStatus(
        `Lade „${file.name}" hoch, lese Event Management + GPS und rechne ab …`,
      );
    } else {
      setStatus(`Lade „${file.name}" hoch, lese Event Management und rechne ab …`);
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
el.fileInput.addEventListener("change", () => {
  const hasFile = el.fileInput.files && el.fileInput.files.length;
  el.uploadBtn.disabled = !hasFile;
  el.selectiveSearchBtn.disabled = !hasFile;
});
el.selectiveSearchBtn.addEventListener("click", selectiveSearch);
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
