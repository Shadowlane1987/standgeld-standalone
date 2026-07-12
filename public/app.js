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
};

let importedTimeWindows = [];

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

async function run() {
  const body = {
    url: String(el.url.value || "").trim(),
    period: String(el.periodMode.value || "day").trim(),
    referenceDate: String(el.referenceDate.value || "").trim(),
    transportNumber: String(el.transportNumber.value || "").trim(),
    tourId: String(el.tourId.value || "").trim(),
    sessionToken: String(el.sessionToken.value || "").trim(),
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
      const arrival = compactDateTimeDisplay(stop.arrival_display);
      const departure = compactDateTimeDisplay(stop.departure_display);
      const ruleStart = compactDateTimeDisplay(stop.rule_start_display);
      const window = compactWindowDisplay(
        stop.slot_begin_display,
        stop.slot_end_display,
      );
      tr.innerHTML = `
        <td>${stop.transport_number || stop.tour_id || "-"}</td>
        <td>${stop.plate || "-"}</td>
        <td>${stop.type || "-"}</td>
        <td>${stop.booking_location || stop.address || "-"}</td>
        <td>${arrival}</td>
        <td>${departure}</td>
        <td>${window}</td>
        <td>${ruleStart}</td>
        <td>${stop.effective_minutes || 0} min</td>
        <td>${stop.billable_minutes || 0} min</td>
        <td>${stop.billed_units || 0}</td>
        <td>${Number(stop.amount_eur || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" })}</td>
      `;
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

el.runBtn.addEventListener("click", run);
