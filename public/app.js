const el = {
  url: document.getElementById("url"),
  periodMode: document.getElementById("periodMode"),
  referenceDate: document.getElementById("referenceDate"),
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
  runBtn: document.getElementById("runBtn"),
  status: document.getElementById("status"),
  resultPanel: document.getElementById("resultPanel"),
  amount: document.getElementById("amount"),
  positions: document.getElementById("positions"),
  units: document.getElementById("units"),
  resultMeta: document.getElementById("resultMeta"),
  rows: document.getElementById("rows"),
  surchargeModal: document.getElementById("surchargeModal"),
  surchargeTitle: document.getElementById("surchargeTitle"),
  surchargeText: document.getElementById("surchargeText"),
  copySurchargeBtn: document.getElementById("copySurchargeBtn"),
  closeSurchargeModalBtn: document.getElementById("closeSurchargeModalBtn"),
  closeSurchargeModalBtn2: document.getElementById("closeSurchargeModalBtn2"),
};

let importedTimeWindows = [];
const URL_STORAGE_KEY = "standgeld.sixfoldUrl";
const SESSION_TOKEN_STORAGE_KEY = "standgeld.sessionToken";

function setStatus(text, type = "info") {
  el.status.textContent = text;
  el.status.style.color =
    type === "error" ? "#b91c1c" : type === "success" ? "#166534" : "#73675a";
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

function excelSingleWindowValue(stop) {
  const raw = String(stop?.excel_window_display || "").trim();
  if (!raw) return "-";
  if (/^\d{1,2}\.\d{2}$/.test(raw)) return raw.replace(".", ":");
  if (/^\d{1,2}:\d{2}$/.test(raw)) return raw;
  const compact = compactDateTimeDisplay(raw);
  return compact || raw;
}

function formatMinutesAsHours(minutesValue) {
  const totalMinutes = Math.max(0, Number(minutesValue || 0));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function buildSurchargeDescription(stop) {
  const arrival = stop.arrival_display || "-";
  const departure = stop.departure_display || "-";
  const windowText = excelSingleWindowValue(stop);
  const effective = formatMinutesAsHours(stop.effective_minutes);
  const billable = formatMinutesAsHours(stop.billable_minutes);

  return [
    `Ankunft: ${arrival}`,
    `Zeitfenster: ${windowText}`,
    `Abfahrt: ${departure}`,
    `Effektive Standzeit: ${effective}`,
    `Abzurechnende Standzeit: ${billable}`,
  ].join("\n");
}

function openSurchargeModal(stop) {
  el.surchargeTitle.textContent = "Zuschlagstext";
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
    transportNumber: String(el.transportNumber.value || "").trim(),
    tourId: String(el.tourId.value || "").trim(),
    sessionToken: resolvedSessionToken,
    rules: {
      freeMinutes: Number(el.freeMinutes.value || 120),
      intervalMinutes: Number(el.unitMinutes.value || 30),
      unitPrice: Number(el.unitPrice.value || 30),
      thresholdEur: Number(el.thresholdEur.value || 30),
      capEur: Number(el.capEur.value || 650),
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
    el.resultMeta.textContent =
      `Neu berechnet: ${data.summary?.recalculated_positions || 0} | ` +
      `Zeitfenster-Matches: ${data.summary?.time_window_matches || 0}/${data.summary?.time_window_rows || 0} | ` +
      `>14h entfernt: ${data.summary?.removed_long_stand_positions || 0} | ` +
      `>=${data.summary?.excluded_from_total_threshold_eur || 450} EUR nicht in Summe: ${data.summary?.excluded_from_total_positions || 0}`;

    el.rows.innerHTML = "";
    for (const stop of data.stops || []) {
      const tr = document.createElement("tr");
      tr.className = "result-row";
      tr.tabIndex = 0;
      const arrival = compactDateTimeDisplay(stop.arrival_display);
      const departure = compactDateTimeDisplay(stop.departure_display);
      const ruleStart = compactDateTimeDisplay(stop.rule_start_display);
      const window = excelSingleWindowValue(stop);
      const effective = formatMinutesAsHours(stop.effective_minutes);
      const billable = formatMinutesAsHours(stop.billable_minutes);
      tr.innerHTML = `
        <td>${stop.transport_number || stop.tour_id || "-"}</td>
        <td>${stop.plate || "-"}</td>
        <td>${stop.type || "-"}</td>
        <td>${stop.booking_location || stop.address || "-"}</td>
        <td>${arrival}</td>
        <td>${departure}</td>
        <td>${window}</td>
        <td>${ruleStart}</td>
        <td>${effective}</td>
        <td>${billable}</td>
        <td>${stop.billed_units || 0}</td>
        <td>${Number(stop.amount_eur || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" })}</td>
      `;
      tr.addEventListener("click", () => openSurchargeModal(stop));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openSurchargeModal(stop);
        }
      });
      el.rows.appendChild(tr);
    }

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

el.runBtn.addEventListener("click", run);
