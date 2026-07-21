"use strict";

/**
 * Parser fuer den Transporeon-EIGENEN Excel-Export der Transportliste
 * (Toolbar "Nach Excel exportieren" -> POST /taweb/exporter).
 *
 * Diese Datei ist die ZUVERLAESSIGE Fensterquelle fuer ALLE Transporte eines
 * Zeitraums: der Export enthaelt je Transport das gebuchte Zeitfenster ("Gebucht
 * ab") UND die Ist-Ankunft/Abfahrt fuer beide Stopps (Laden = erste Buchung,
 * Entladen = "Zweite Buchung") mit vollem Datum in lokaler Zeit (Europe/Berlin).
 *
 * Vorteil gegenueber Grid-Scraping/Wire-Parsing: eine Datei, alle Zeilen, stabil.
 *
 * Reine Funktionen (kein Datei-I/O). Das .xlsx-Lesen macht
 * server/tools/readTransporeonExport.js.
 *
 * Fachregel Zuordnung Spalte -> Stopp:
 * - "Gebucht ab / Ankunft / Abfahrt (- Time Slot Management)" = LADESTELLE.
 * - "... - Zweite Buchung ..."                                = ENTLADESTELLE.
 * Fehlt die "Zweite Buchung", hat der Transport nur einen (Lade-)Stopp.
 */

const { EVENT_CATEGORY, normalizeEventRow } = require("./events");

// Der Export traegt die Transporeon-eigenen Ist-Zeiten ("TP XP"-Standortmeldung)
// in lokaler Wanduhrzeit (Europe/Berlin). Diese Konstanten machen die
// abgeleiteten Events fuer die Gegenpruefung (crossCheck) eindeutig als
// TP-XP-Quelle erkennbar -- die GPS-Bewertung bleibt Sache der Visibility.
const EXPORT_SOURCE = "TP XP Service Account";
const EXPORT_TIMEZONE = "Europe/Berlin";

// Header-Erkennung ueber Teilstrings (robust gegen Zusatz-Suffixe/Sprache-Reste).
const COLUMN_MATCHERS = Object.freeze({
  transport_number: (h) => h === "transportnr." || h.startsWith("transportnr"),
  vehicle_registration: (h) =>
    h.includes("kfz-kennz") ||
    h.includes("kennzeichen") ||
    h.includes("license"),
  load_window: (h) => h.startsWith("gebucht ab") && !h.includes("zweite"),
  load_arrival: (h) => h.startsWith("ankunft") && !h.includes("zweite"),
  load_departure: (h) => h.startsWith("abfahrt") && !h.includes("zweite"),
  unload_window: (h) => h.startsWith("gebucht ab") && h.includes("zweite"),
  unload_arrival: (h) => h.startsWith("ankunft") && h.includes("zweite"),
  unload_departure: (h) => h.startsWith("abfahrt") && h.includes("zweite"),
});

function normHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Normalisiert eine Datums-/Zeitzelle des Exports ("YYYY-MM-DD HH:MM") zu einem
 * lokalen Wanduhr-String oder null. Platzhalter ("-", "") ergeben null.
 *
 * @param {string} value
 * @returns {string|null}
 */
function cleanDateTime(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "-") return null;
  const m = text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/**
 * Findet die Kopfzeile und ordnet die benoetigten Spalten ihren Indizes zu.
 *
 * @param {Array<Array<string>>} rows
 * @returns {{ headerIndex: number, columns: Record<string, number> }|null}
 */
function locateHeader(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || [];
    const columns = {};
    for (let c = 0; c < row.length; c += 1) {
      const h = normHeader(row[c]);
      if (!h) continue;
      for (const [key, match] of Object.entries(COLUMN_MATCHERS)) {
        if (columns[key] == null && match(h)) columns[key] = c;
      }
    }
    if (columns.transport_number != null && columns.load_window != null) {
      return { headerIndex: i, columns };
    }
  }
  return null;
}

function cell(row, index) {
  if (index == null) return "";
  return String(row[index] ?? "").trim();
}

function toComparableMs(localDateTime) {
  const text = String(localDateTime || "").trim();
  if (!text) return null;
  const iso = text.replace(" ", "T") + ":00";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function shouldSwapStops(loading, unloading) {
  if (!loading || !unloading) return false;

  // Nur bei klarer Voll-Inversion tauschen: beide Endpunkte vorhanden und
  // Lade-Ankunft/Abfahrt liegen jeweils NACH Entlade-Ankunft/Abfahrt.
  const loadArr = toComparableMs(loading.arrival_local);
  const loadDep = toComparableMs(loading.departure_local);
  const unloadArr = toComparableMs(unloading.arrival_local);
  const unloadDep = toComparableMs(unloading.departure_local);

  if (
    loadArr === null ||
    loadDep === null ||
    unloadArr === null ||
    unloadDep === null
  ) {
    return false;
  }

  return loadArr > unloadArr && loadDep > unloadDep;
}

/**
 * Parst die Export-Rohzeilen (Array-of-Arrays inkl. Kopfzeile).
 *
 * @param {Array<Array<string>>} rows
 * @returns {Array<Readonly<{
 *   transport_number: string,
 *   loading: {window_local:string|null, arrival_local:string|null, departure_local:string|null}|null,
 *   unloading: {window_local:string|null, arrival_local:string|null, departure_local:string|null}|null
 * }>>}
 */
function parseTransporeonExport(rows) {
  const header = locateHeader(rows);
  if (!header) return [];

  const { headerIndex, columns } = header;
  const list = Array.isArray(rows) ? rows : [];
  const out = [];

  for (let i = headerIndex + 1; i < list.length; i += 1) {
    const row = list[i] || [];
    const transportNumber = cell(row, columns.transport_number);
    if (!transportNumber) continue;

    const vehicleRegistration = cell(row, columns.vehicle_registration);
    const loadWin = cleanDateTime(cell(row, columns.load_window));
    const loadArr = cleanDateTime(cell(row, columns.load_arrival));
    const loadDep = cleanDateTime(cell(row, columns.load_departure));
    const unloadWin = cleanDateTime(cell(row, columns.unload_window));
    const unloadArr = cleanDateTime(cell(row, columns.unload_arrival));
    const unloadDep = cleanDateTime(cell(row, columns.unload_departure));

    let loading =
      loadWin || loadArr || loadDep
        ? {
            window_local: loadWin,
            arrival_local: loadArr,
            departure_local: loadDep,
          }
        : null;
    let unloading =
      unloadWin || unloadArr || unloadDep
        ? {
            window_local: unloadWin,
            arrival_local: unloadArr,
            departure_local: unloadDep,
          }
        : null;

    if (shouldSwapStops(loading, unloading)) {
      const tmp = loading;
      loading = unloading;
      unloading = tmp;
    }

    out.push(
      Object.freeze({
        transport_number: transportNumber,
        vehicle_registration: vehicleRegistration || null,
        loading,
        unloading,
      }),
    );
  }

  return out;
}

/**
 * Baut die Fenster-Map fuer die Abrechnung aus dem Export.
 *
 * WICHTIG: Der Wert ist die VOLLE lokale Wanduhrzeit ("YYYY-MM-DD HH:MM"), nicht
 * nur "HH:MM". Damit ist auch das Uebernacht-Fenster (Entladen am Folgetag)
 * eindeutig. billing.js erkennt das Datum und rekonstruiert NICHT mit dem
 * Stopp-Datum.
 *
 * Nur das Zeitfenster ("Gebucht ab") stammt aus dem Export; die beweisbaren
 * Ist-Zeiten (VisibilityHubUser/Sixfold, GPS) kommen weiterhin aus der
 * Visibility-Abfrage. Ankunft/Abfahrt des Exports sind reine TP-XP-Werte.
 *
 * @param {Array<object>} transports - aus parseTransporeonExport()
 * @returns {Map<string, string>} Key "<transport_number>|<STOPTYPE>" -> lokales
 *   "YYYY-MM-DD HH:MM"
 */
function exportToWindowMap(transports) {
  const map = new Map();
  for (const t of transports || []) {
    if (!t || !t.transport_number) continue;
    if (t.loading && t.loading.window_local) {
      map.set(`${t.transport_number}|LOADING`, t.loading.window_local);
    }
    if (t.unloading && t.unloading.window_local) {
      map.set(`${t.transport_number}|UNLOADING`, t.unloading.window_local);
    }
  }
  return map;
}

/**
 * Wandelt die geparsten Export-Transporte in normalisierte Rohevents (TP-XP)
 * fuer die Gegenpruefung. Damit stehen die Transporeon-eigenen Ist-Ankunft/
 * Abfahrt fuer BEIDE Stopps als belastbare Zeitquelle bereit -- vor allem am
 * ENTLADEORT, wo die VisibilityHubUser-Meldung oft nur automatisch (0/0, ohne
 * echtes GPS) gesetzt ist.
 *
 * WICHTIG (Fachlogik): Es wird nichts erfunden und keine Gebuehr berechnet.
 * Die Events sind gleichwertig zu den TP-XP-Events aus der Wire-Antwort:
 * crossCheck bevorzugt weiterhin GPS-verifizierte VisibilityHubUser-Zeiten und
 * nutzt die Export-Zeit nur, wo kein belegtes GPS vorliegt (dann Prueffall).
 *
 * @param {Array<object>} transports - aus parseTransporeonExport()
 * @param {{ importRunId?: string, importedAt?: string }} [ctx]
 * @returns {Array<object>} normalisierte, unveraenderliche Rohevents
 */
function exportToEvents(transports, ctx = {}) {
  const events = [];
  let order = 0;

  const push = (transportNumber, category, qualifier, localTime) => {
    if (!localTime) return;
    events.push(
      normalizeEventRow(
        {
          transport_number: transportNumber,
          event_category: category,
          status_qualifier: qualifier,
          event_name: qualifier,
          event_time: localTime,
          timezone: EXPORT_TIMEZONE,
          source: EXPORT_SOURCE,
          origin: "EXPORT",
        },
        {
          importRunId: ctx.importRunId,
          importedAt: ctx.importedAt,
          orderIndex: order++,
        },
      ),
    );
  };

  for (const t of transports || []) {
    if (!t || !t.transport_number) continue;
    const tn = t.transport_number;
    if (t.loading) {
      push(
        tn,
        EVENT_CATEGORY.LOAD_ARRIVAL,
        "status.loading.arrival",
        t.loading.arrival_local,
      );
      push(
        tn,
        EVENT_CATEGORY.LOAD_DEPARTURE,
        "status.loading.departure",
        t.loading.departure_local,
      );
    }
    if (t.unloading) {
      push(
        tn,
        EVENT_CATEGORY.UNLOAD_ARRIVAL,
        "status.unloading.arrival",
        t.unloading.arrival_local,
      );
      push(
        tn,
        EVENT_CATEGORY.UNLOAD_DEPARTURE,
        "status.unloading.departure",
        t.unloading.departure_local,
      );
    }
  }

  return events;
}

module.exports = {
  cleanDateTime,
  locateHeader,
  parseTransporeonExport,
  exportToWindowMap,
  exportToEvents,
};
