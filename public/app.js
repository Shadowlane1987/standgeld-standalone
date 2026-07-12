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
    .replace(/\s+/g, " ");
}

function getCellValue(row, keySet) {
  for (const [key, value] of Object.entries(row || {})) {
    if (keySet.has(normalizeHeader(key))) return value;
  }
  return "";
}

function parseExcelTimeWindows(rows) {
  const keyMap = {
    stopType: new Set(["typ", "stop type", "stopp typ", "stoptyp"]),
    location: new Set(["ort", "location", "buchungsort", "booking location"]),
    cola: new Set(["cola", "cola nummer", "cola-nummer"]),
    load: new Set(["ladenummer", "load number", "load", "ladenr"]),
    routeKey: new Set(["route", "tour", "route key", "tour key"]),
    transport: new Set(["transport", "transportnummer", "transport number"]),
    tourId: new Set(["tour id", "tourid", "trip id"]),
    windowStart: new Set([
      "zeitfenster start",
      "window start",
      "fenster von",
      "von",
      "start",
      "time from",
    ]),
    windowEnd: new Set([
      "zeitfenster ende",
      "window end",
      "fenster bis",
      "bis",
      "ende",
      "time to",
    ]),
  };

  return rows
    .map((row) => {
      const stopTypeRaw = String(getCellValue(row, keyMap.stopType) || "")
        .trim()
        .toLowerCase();
      const stopType =
        stopTypeRaw.includes("un") || stopTypeRaw.includes("ent")
          ? "unload"
          : stopTypeRaw.includes("loa") || stopTypeRaw.includes("bel")
            ? "load"
            : "any";

      const windowStart = getCellValue(row, keyMap.windowStart);
      const windowEnd = getCellValue(row, keyMap.windowEnd);
      if (
        !String(windowStart || "").trim() &&
        !String(windowEnd || "").trim()
      ) {
        return null;
      }

      return {
        stop_type: stopType,
        location: String(getCellValue(row, keyMap.location) || "").trim(),
        cola_number: String(getCellValue(row, keyMap.cola) || "").trim(),
        load_number: String(getCellValue(row, keyMap.load) || "").trim(),
        route_key: String(getCellValue(row, keyMap.routeKey) || "").trim(),
        transport_number: String(
          getCellValue(row, keyMap.transport) || "",
        ).trim(),
        tour_id: String(getCellValue(row, keyMap.tourId) || "").trim(),
        window_start: String(windowStart || "").trim(),
        window_end: String(windowEnd || "").trim(),
      };
    })
    .filter(Boolean);
}

async function importTimeWindowsFromExcel() {
  const file = el.timeWindowFile.files?.[0];
  if (!file) throw new Error("Bitte zuerst eine Excel-Datei auswählen.");

  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName)
    throw new Error("Excel-Datei enthält kein Tabellenblatt.");

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  importedTimeWindows = parseExcelTimeWindows(rows);
  if (!importedTimeWindows.length) {
    throw new Error("Keine verwertbaren Zeitfenster in der Datei gefunden.");
  }
  el.timeWindowMeta.textContent = `Zeitfenster importiert: ${importedTimeWindows.length} Zeilen.`;
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

function formatMinutesAsHours(minutesValue) {
  const totalMinutes = Math.max(0, Number(minutesValue || 0));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function mapStopTypeToPlace(typeValue) {
  const type = String(typeValue || "").toLowerCase();
  if (type.includes("load") || type.includes("belad")) return "Ladestelle";
  if (type.includes("unload") || type.includes("entlad"))
    return "Entladestelle";
  return "Stelle";
}

function buildSurchargeDescription(stop) {
  const transport = stop.transport_number || stop.tour_id || "-";
  const plate = stop.plate || "-";
  const placeLabel = mapStopTypeToPlace(stop.type);
  const place = stop.booking_location || stop.address || "-";
  const arrival = stop.arrival_display || "-";
  const departure = stop.departure_display || "-";
  const windowText = compactWindowDisplay(
    stop.slot_begin_display,
    stop.slot_end_display,
  );
  const effective = formatMinutesAsHours(stop.effective_minutes);
  const billable = formatMinutesAsHours(stop.billable_minutes);
  const units = Number(stop.billed_units || 0);
  const amount = Number(stop.amount_eur || 0).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });

  return [
    "Standzeitnachweis fuer Zuschlag:",
    `Transport: ${transport}`,
    `Kennzeichen: ${plate}`,
    `${placeLabel}: ${place}`,
    `Ankunft: ${arrival}`,
    `Zeitfenster ${placeLabel}: ${windowText}`,
    `Abfahrt: ${departure}`,
    `Effektive Standzeit: ${effective}`,
    `Abzurechnen: ${billable} (${units} Takte, ${amount})`,
  ].join("\n");
}

function openSurchargeModal(stop) {
  const transport = stop.transport_number || stop.tour_id || "-";
  el.surchargeTitle.textContent = `Zuschlagstext fuer Sendung ${transport}`;
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
      `>14h entfernt: ${data.summary?.removed_long_stand_positions || 0}`;

    el.rows.innerHTML = "";
    for (const stop of data.stops || []) {
      const tr = document.createElement("tr");
      tr.className = "result-row";
      tr.tabIndex = 0;
      const arrival = compactDateTimeDisplay(stop.arrival_display);
      const departure = compactDateTimeDisplay(stop.departure_display);
      const ruleStart = compactDateTimeDisplay(stop.rule_start_display);
      const window = compactWindowDisplay(
        stop.slot_begin_display,
        stop.slot_end_display,
      );
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
    await importTimeWindowsFromExcel();
    setStatus("Zeitfenster erfolgreich importiert.", "success");
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
