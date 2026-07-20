"use strict";

const el = {
  freeMinutes: document.getElementById("freeMinutes"),
  blockMinutes: document.getElementById("blockMinutes"),
  blockRateEur: document.getElementById("blockRateEur"),
  triggerMinutes: document.getElementById("triggerMinutes"),
  loadBtn: document.getElementById("loadBtn"),
  status: document.getElementById("status"),
  resultPanel: document.getElementById("resultPanel"),
  transportCount: document.getElementById("transportCount"),
  stopCount: document.getElementById("stopCount"),
  chargeableCount: document.getElementById("chargeableCount"),
  reviewCount: document.getElementById("reviewCount"),
  totalFee: document.getElementById("totalFee"),
  filterMode: document.getElementById("filterMode"),
  rows: document.getElementById("rows"),
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

function filteredStops() {
  const mode = el.filterMode.value;
  if (mode === "chargeable") return currentStops.filter((s) => s.fee_eur > 0);
  if (mode === "review") return currentStops.filter((s) => s.needs_review);
  return currentStops;
}

function render() {
  const stops = filteredStops();
  el.rows.innerHTML = "";

  for (const stop of stops) {
    const tr = document.createElement("tr");
    if (stop.needs_review) tr.className = "review-row";
    else if (stop.fee_eur > 0) tr.className = "chargeable-row";

    const statusLabel = stop.needs_review
      ? "Prüfen"
      : REASON_LABELS[stop.reason] || stop.reason || "-";

    tr.innerHTML = `
      <td>${stop.transport_number || "-"}</td>
      <td>${TYPE_LABELS[stop.stop_type] || stop.stop_type || "-"}</td>
      <td>${stop.window_local || "-"}</td>
      <td>${stop.arrival_local || "-"}</td>
      <td>${stop.departure_local || "-"}</td>
      <td>${isoToLocal(stop.count_start)}</td>
      <td>${minutesToHours(stop.counted_standing_minutes)}</td>
      <td>${minutesToHours(stop.minutes_over_free)}</td>
      <td>${stop.billable_blocks || 0}</td>
      <td>${euro(stop.fee_eur)}</td>
      <td>${statusLabel}</td>
    `;
    el.rows.appendChild(tr);
  }
}

async function load() {
  setStatus("Lade Transporte …");
  el.loadBtn.disabled = true;

  const params = new URLSearchParams({
    freeMinutes: el.freeMinutes.value,
    blockMinutes: el.blockMinutes.value,
    blockRateEur: el.blockRateEur.value,
    triggerMinutes: el.triggerMinutes.value,
  });

  try {
    const res = await fetch(`/api/billing/export?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    currentStops = data.stops || [];
    el.transportCount.textContent = data.summary.transport_count;
    el.stopCount.textContent = data.summary.stop_count;
    el.chargeableCount.textContent = data.summary.chargeable_count;
    el.reviewCount.textContent = data.summary.review_count;
    el.totalFee.textContent =
      data.summary.total_fee_display || euro(data.summary.total_fee_eur);

    el.resultPanel.hidden = false;
    render();
    setStatus(
      `${data.summary.transport_count} Transporte geladen · ${data.summary.stop_count} Positionen.`,
      "success",
    );
  } catch (error) {
    setStatus(error.message || "Fehler beim Laden", "error");
  } finally {
    el.loadBtn.disabled = false;
  }
}

el.loadBtn.addEventListener("click", load);
el.filterMode.addEventListener("change", render);

// Beim Öffnen direkt laden.
load();
