"use strict";

/**
 * Abrechnungslauf Standgeld ueber einen Datumsbereich (§ Abrechnung).
 *
 * Bindet die Pipeline zusammen:
 *   Stopps (standing.buildStops)
 *     -> Fenster-Startzeit je Stopp waehlen (Transporeon PRIMAER, Excel FALLBACK)
 *     -> Standgeld je Stopp (standgeld.computeStandgeld)
 *     -> nach Datumsbereich (von/bis) filtern und summieren.
 *
 * Fachregeln (Nutzer 2026-07-17):
 * - Fensterzeit = ERSTE Zeit des Slots. Quelle Transporeon-Slot hat Vorrang;
 *   fehlt das (Entlade-)Fenster in Transporeon, kommt es aus der Excel-Liste.
 * - Verknuepfung Excel <-> Transport ueber die Ladenummer (letzte 7 Ziffern).
 * - Abrechnung waehlbar ueber Datumsbereich (z.B. 13.07. bis 16.07.): alle
 *   Transporte/Stopps im Bereich werden durchgerechnet.
 *
 * Reine, unit-testbare Funktionen (kein I/O).
 */

const { toUtcIso, isValidTimeZone } = require("./datetime");
const { windowStartForStop } = require("./zeitfenster");
const { transportNumberToLadenummer } = require("./ladenummer");
const { computeStandgeld } = require("./standgeld");

const WINDOW_SOURCE = Object.freeze({
  TRANSPOREON: "TRANSPOREON",
  EXCEL: "EXCEL",
  NONE: "NONE",
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

function wallDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function zoneDate(utcIso, timeZone) {
  if (!utcIso) return null;
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return null;
  if (!isValidTimeZone(timeZone)) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  // en-CA liefert das Format YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Lokales Kalenderdatum eines Stopps (Basis fuer Fensterdatum + Bereichsfilter).
 * Bevorzugt die Ankunft, dann die Abfahrt.
 *
 * @param {object} stop
 * @returns {string|null} "YYYY-MM-DD"
 */
function stopLocalDate(stop) {
  return (
    wallDate(stop.arrival_local) ||
    wallDate(stop.departure_local) ||
    zoneDate(stop.arrival_time, stop.timezone) ||
    zoneDate(stop.departure_time, stop.timezone) ||
    null
  );
}

function lookupTransporeonWindow(
  transporeonWindows,
  transportNumber,
  stopType,
) {
  if (!transporeonWindows) return null;
  const key = `${transportNumber ?? ""}|${stopType ?? ""}`;
  if (transporeonWindows instanceof Map) {
    return transporeonWindows.get(key) ?? null;
  }
  return transporeonWindows[key] ?? null;
}

/**
 * Waehlt die Fenster-Startzeit fuer einen Stopp.
 * Transporeon-Slot hat Vorrang; sonst Excel-Fallback ueber die Ladenummer.
 *
 * @param {object} stop
 * @param {{ excelIndex?: Map<string,object>, transporeonWindows?: Map<string,string>|object }} deps
 * @returns {{ window_start: string|null, window_source: string, window_local: string|null, local_date: string|null }}
 */
function resolveWindowStart(stop, deps = {}) {
  const stopType = stop.stop_type;
  const localDate = stopLocalDate(stop);
  const timezone = stop.timezone ?? null;

  const transporeonTime = lookupTransporeonWindow(
    deps.transporeonWindows,
    stop.transport_number,
    stopType,
  );

  let chosenTime = null;
  let source = WINDOW_SOURCE.NONE;

  if (transporeonTime) {
    chosenTime = transporeonTime;
    source = WINDOW_SOURCE.TRANSPOREON;
  } else if (deps.excelIndex) {
    const ladenummer = transportNumberToLadenummer(stop.transport_number);
    const excelWindow = ladenummer ? deps.excelIndex.get(ladenummer) : null;
    const excelTime = windowStartForStop(excelWindow, stopType);
    if (excelTime) {
      chosenTime = excelTime;
      source = WINDOW_SOURCE.EXCEL;
    }
  }

  let windowStart = null;
  let windowLocal = null;
  if (chosenTime) {
    // Fensterwert mit vollem Datum ("YYYY-MM-DD HH:MM", z.B. aus dem Transporeon-
    // Export) direkt verwenden -> korrekt auch fuer Uebernacht-Fenster.
    // Reiner "HH:MM"-Wert (Excel) wird mit dem lokalen Stopp-Datum kombiniert.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(chosenTime)) {
      windowLocal = chosenTime.replace("T", " ");
      windowStart = toUtcIso(windowLocal, timezone);
    } else if (localDate) {
      windowLocal = `${localDate} ${chosenTime}`;
      windowStart = toUtcIso(windowLocal, timezone);
    }
  }

  return {
    window_start: windowStart,
    window_source: source,
    window_local: windowLocal,
    local_date: localDate,
  };
}

/**
 * Berechnet das Standgeld fuer einen einzelnen Stopp inkl. Fensterwahl.
 *
 * @param {object} stop
 * @param {object} deps siehe resolveWindowStart
 * @param {object} [config] siehe computeStandgeld
 * @returns {Readonly<object>}
 */
function computeStopBilling(stop, deps = {}, config) {
  const win = resolveWindowStart(stop, deps);

  const fee = computeStandgeld(
    {
      arrival_time: stop.arrival_time,
      departure_time: stop.departure_time,
      window_start: win.window_start,
      needs_review: stop.needs_review,
      transport_number: stop.transport_number,
      delivery_number: stop.delivery_number,
      stop_type: stop.stop_type,
    },
    config,
  );

  return Object.freeze({
    ...fee,
    window_source: win.window_source,
    window_local: win.window_local,
    local_date: win.local_date,
    timezone: stop.timezone ?? null,
  });
}

/**
 * Parst eine Bereichsgrenze zu "YYYY-MM-DD".
 * Akzeptiert "2026-07-13", "13.07.2026", "13.07." / "13.07" (Jahr aus options).
 *
 * @param {string|Date|null} input
 * @param {{ year?: number }} [options]
 * @returns {string|null}
 */
function parseRangeBoundary(input, options = {}) {
  if (input == null || input === "") return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime())
      ? null
      : input.toISOString().slice(0, 10);
  }

  const s = String(input).trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s;
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) {
    return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  if ((m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(s))) {
    const year = options.year || new Date().getFullYear();
    return `${year}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  return null;
}

/**
 * Prueft, ob ein Datum (YYYY-MM-DD) im inklusiven Bereich [from, to] liegt.
 * Offene Grenzen (null) sind erlaubt.
 *
 * @param {string|null} dateStr
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
function dateInRange(dateStr, from, to) {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

/**
 * Fuehrt den Abrechnungslauf ueber alle Stopps durch und filtert nach Bereich.
 *
 * @param {object} params
 * @param {Array<object>} params.stops - aus standing.buildStops()
 * @param {Map<string,object>} [params.excelIndex] - aus zeitfenster.buildWindowIndex()
 * @param {Map<string,string>|object} [params.transporeonWindows] - Key "TRANSPORT|STOPTYPE" -> "HH:MM"
 * @param {{ from?: string|Date|null, to?: string|Date|null, year?: number }} [params.range]
 * @param {object} [params.config] - siehe computeStandgeld
 * @returns {Readonly<object>}
 */
function runBilling(params = {}) {
  const stops = Array.isArray(params.stops) ? params.stops : [];
  const range = params.range || {};
  const from = parseRangeBoundary(range.from, { year: range.year });
  const to = parseRangeBoundary(range.to, { year: range.year });

  const deps = {
    excelIndex: params.excelIndex,
    transporeonWindows: params.transporeonWindows,
  };

  const items = stops.map((stop) => {
    const billing = computeStopBilling(stop, deps, params.config);
    const hasRange = Boolean(from || to);
    const inRange = hasRange ? dateInRange(billing.local_date, from, to) : true;
    return Object.freeze({ ...billing, in_range: inRange });
  });

  const selected = items.filter((item) => item.in_range);

  let totalFee = 0;
  let chargeableCount = 0;
  let reviewCount = 0;
  for (const item of selected) {
    // Prueffaelle bleiben abrechenbar markiert, werden aber nicht aufsummiert.
    totalFee += item.needs_review ? 0 : item.fee_eur || 0;
    if (item.chargeable) chargeableCount += 1;
    if (item.needs_review) reviewCount += 1;
  }

  return Object.freeze({
    range: Object.freeze({ from, to }),
    items,
    selected,
    summary: Object.freeze({
      stop_count: items.length,
      selected_count: selected.length,
      chargeable_count: chargeableCount,
      review_count: reviewCount,
      total_fee_eur: totalFee,
    }),
  });
}

module.exports = {
  WINDOW_SOURCE,
  stopLocalDate,
  resolveWindowStart,
  computeStopBilling,
  parseRangeBoundary,
  dateInRange,
  runBilling,
};
