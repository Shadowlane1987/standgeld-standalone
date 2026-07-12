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

function normalizeLoose(value) {
  return normalizeHeader(value).replace(/[^a-z0-9]/g, "");
}

function getCellValue(row, keySet) {
  const aliases = Array.from(keySet || []).map((value) => normalizeLoose(value));
  for (const [key, value] of Object.entries(row || {})) {
    const normalizedKey = normalizeLoose(key);
    if (
      aliases.some(
        (alias) =>
          normalizedKey === alias ||
          normalizedKey.includes(alias) ||
          alias.includes(normalizedKey),
      )
    ) {
      return value;
    }
  }
  return "";
}

function looksLikeTimeValue(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return true;
  if (/^\d{1,2}\.\d{2}$/.test(text)) return true;
  if (/^0[\.,]\d+$/.test(text)) return true;
  return false;
}

function extractTimeCandidates(row) {
  return Object.values(row || {})
    .map((value) => String(value || "").trim())
    .filter((value) => looksLikeTimeValue(value));
}

function parseExcelTimeWindows(rows) {
  const keyMap = {
    stopType: new Set(["typ", "stop type", "stopp typ", "stoptyp"]),
    location: new Set([
      "ort",
      "location",
      "buchungsort",
      "booking location",
      "ladestelle",
      "entladestelle",
    ]),
    loadLocation: new Set(["ladestelle", "lade stelle", "loading place"]),
    unloadLocation: new Set([
      "entladestelle",
      "entlade stelle",
      "unloading place",
    ]),
    cola: new Set(["cola", "cola nummer", "cola-nummer"]),
    load: new Set([
      "ladenummer",
      "ladenummerr",
      "ladenumm",
      "load number",
      "load",
      "ladenr",
    ]),
    routeKey: new Set([
      "route",
      "tour",
      "route key",
      "tour key",
      "tournummer",
      "tournummer",
      "tour nr",
      "tournr",
    ]),
    transport: new Set(["transport", "transportnummer", "transport number"]),
    tourId: new Set(["tour id", "tourid", "trip id"]),
    windowStart: new Set([
      "zeitfenster start",
      "window start",
      "startzeit",
      "ladezeit",
      "ankunftszeit",
      "fenster von",
      "von",
      "start",
      "time from",
    ]),
    windowEnd: new Set([
      "zeitfenster ende",
      "window end",
      "endzeit",
      "entladezeit",
      "abfahrtszeit",
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

      let windowStart = String(getCellValue(row, keyMap.windowStart) || "").trim();
      let windowEnd = String(getCellValue(row, keyMap.windowEnd) || "").trim();

      if (!windowStart && !windowEnd) {
        const timeCandidates = extractTimeCandidates(row);
        windowStart = timeCandidates[0] || "";
        windowEnd = timeCandidates[1] || "";
      }

      if (
        !String(windowStart || "").trim() &&
        !String(windowEnd || "").trim()
      ) {
        return null;
      }

      const loadLocation = String(getCellValue(row, keyMap.loadLocation) || "").trim();
      const unloadLocation = String(getCellValue(row, keyMap.unloadLocation) || "").trim();
      const locationBase = String(getCellValue(row, keyMap.location) || "").trim();
      const location = locationBase || [loadLocation, unloadLocation].filter(Boolean).join(" -> ");

      return {
        stop_type: stopType,
        location,
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

function buildSurchargeDescription(stop) {
  const arrival = stop.arrival_display || "-";
  const departure = stop.departure_display || "-";
  const windowText = compactWindowDisplay(
    stop.slot_begin_display,
    stop.slot_end_display,
  );
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
