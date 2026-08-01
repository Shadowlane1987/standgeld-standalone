"use strict";

/**
 * Sixfold-First-Ergänzung für die Batch-Abrechnung.
 *
 * Grundgedanke (Nutzer-Vorgabe 2026-07-31): Die Abrechnung startet wie die
 * Einzelabrechnung über den Sixfold-Link und legt Transporeon-Excel +
 * Zeitfenster-Excel als Abgleich obendrauf. ALLE Touren bleiben drin.
 * Wo ein Kennzeichen hinterlegt ist, gelten die GPS-Zeiten; wo keins
 * hinterlegt ist, gelten die Excel-Zeiten.
 *
 * Der Excel-Teil (mit GPS-Overlay + Kennzeichen-Regel) wird bereits von
 * billFromExport(transports, {gpsIndex}) erledigt. Dieses Modul ergänzt NUR die
 * Touren, die es AUSSCHLIESSLICH in Sixfold gibt (Transportnummer nicht im
 * Excel-Export), damit keine GPS-belegte Tour verloren geht.
 *
 * Reine Funktion (kein I/O).
 */

const { computeStandgeld } = require("./standgeld");
const { normalizeTransportNumber } = require("./exportBilling");
const { transportNumberToLadenummer } = require("./ladenummer");
const {
  windowStartForStop,
  isPlaceholderWindowTime,
} = require("./zeitfenster");
const { isValidTimeZone } = require("./datetime");

const DEFAULT_TZ = "Europe/Berlin";

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Lokale Wanduhrzeit ("YYYY-MM-DD HH:MM") eines ISO-Zeitstempels in der Zone.
function localWallClockFromIso(iso, timeZone) {
  const ms = parseMs(iso);
  if (ms === null) return null;
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TZ;
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.create(null);
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hh = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}`;
}

// Ganztaegiges Buchungsfenster aus Transporeon (z.B. 00:01-23:59) ist KEIN
// echtes Zeitfenster, sondern nur ein Lueckenfueller. Drei Signale erkennen es,
// alle ROBUST auf UTC-Servern (Render):
//  1) Dauer begin->end >= ~22h (ganzer Tag). Zeitzonen-UNABHAENGIG.
//  2) Rohe Startuhrzeit im ISO-String ist 00:00/00:01 (ohne Zeitzonen-Mathe;
//     faengt auch ISO-Strings OHNE Offset ab, die sonst falsch umgerechnet wuerden).
//  3) Lokale Startuhrzeit 00:00/00:01 (letzter Fallback).
const PLACEHOLDER_MIN_SPAN_MS = 22 * 60 * 60 * 1000;

function isAllDaySpan(beginIso, endIso) {
  const a = parseMs(beginIso);
  const b = parseMs(endIso);
  if (a === null || b === null) return false;
  return b - a >= PLACEHOLDER_MIN_SPAN_MS;
}

// Uhrzeit direkt aus dem ISO-String lesen (kein Date/Zeitzonen-Umrechnen).
function rawIsoTimeIsMidnight(iso) {
  const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
  if (!m) return false;
  const hh = m[1];
  const mm = m[2];
  return hh === "00" && (mm === "00" || mm === "01");
}

function isPlaceholderTimeslot(beginIso, endIso, timeZone) {
  if (isAllDaySpan(beginIso, endIso)) return true;
  if (rawIsoTimeIsMidnight(beginIso)) return true;
  const local = localWallClockFromIso(beginIso, timeZone);
  return local ? isPlaceholderWindowTime(local) : false;
}

// Setzt die Uhrzeit (HH:MM) aus dem Zeitfenster-Excel auf das Datum + die
// Zeitzone eines vorhandenen Sixfold-ISO-Zeitstempels. So bleibt der Tag der
// Tour erhalten und die Zeitzone stimmt (wichtig auf UTC-Servern wie Render).
function applyTimeToIsoDate(refIso, hhmm) {
  const ref = String(refIso || "").match(
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/,
  );
  const hm = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!ref || !hm) return null;
  const date = ref[1];
  const offset = ref[2] || "Z";
  const hh = String(hm[1]).padStart(2, "0");
  return {
    iso: `${date}T${hh}:${hm[2]}:00${offset}`,
    local: `${date} ${hh}:${hm[2]}`,
  };
}

function earliest(a, b) {
  const x = parseMs(a);
  const y = parseMs(b);
  if (x === null) return b || null;
  if (y === null) return a || null;
  return y < x ? b : a;
}

function latest(a, b) {
  const x = parseMs(a);
  const y = parseMs(b);
  if (x === null) return b || null;
  if (y === null) return a || null;
  return y > x ? b : a;
}

/**
 * Verifizierte GPS-Zeiten eines Sixfold-Stopps (nur echte Koordinaten +
 * bestätigtes Ankunfts-/Abfahrts-Ereignis).
 */
function verifiedGps(stop) {
  const gps = stop?.gps || {};
  const coords = stop?.position || {};
  const zero =
    (Number(coords.lat) || 0) === 0 && (Number(coords.lng) || 0) === 0;
  return {
    arrival_iso:
      gps.arrival_verified && !zero ? stop.arrival_time || null : null,
    departure_iso:
      gps.departure_verified && !zero ? stop.departure_time || null : null,
  };
}

/**
 * Ergänzt das Excel-Abrechnungsergebnis um Touren, die NUR in Sixfold vorhanden
 * sind. Diese werden aus verifizierten GPS-Zeiten plus dem Sixfold-Buchungs-
 * fenster abgerechnet.
 *
 * @param {{stops: Array<object>, summary: object}} excelResult - aus billFromExport()
 * @param {{
 *   transports?: Array<object>,
 *   sixfoldStops?: Array<object>,
 *   config?: object,
 *   timezone?: string,
 * }} options
 * @returns {{stops: Array<object>, summary: object}}
 */
function appendSixfoldOnlyStops(excelResult, options = {}) {
  const baseStops = Array.isArray(excelResult?.stops)
    ? excelResult.stops.slice()
    : [];
  const baseSummary = excelResult?.summary || {};
  const transports = Array.isArray(options.transports)
    ? options.transports
    : [];
  const sixfoldStops = Array.isArray(options.sixfoldStops)
    ? options.sixfoldStops
    : [];
  const config = options.config || {};
  const timezone = options.timezone || DEFAULT_TZ;
  // Zeitfenster-Excel-Index (per Ladenummer) fuer Entlade-Fenster.
  const unloadWindowIndex =
    options.unloadWindowIndex &&
    typeof options.unloadWindowIndex.get === "function"
      ? options.unloadWindowIndex
      : null;
  let unloadWindowFromExcel = 0;

  // Bereits über Excel abgedeckte Transportnummern (normalisiert).
  const excelTns = new Set();
  for (const t of transports) {
    const norm = normalizeTransportNumber(t?.transport_number);
    if (norm) excelTns.add(norm);
  }

  // Sixfold-Stopps nach normTN|TYPE gruppieren (Mehrfachbesuch: früheste
  // Ankunft / späteste Abfahrt); nur Touren OHNE Excel-Abdeckung.
  const groups = new Map();
  for (const s of sixfoldStops) {
    const tn = String(s?.transport_number || "").trim();
    if (!tn) continue;
    const norm = normalizeTransportNumber(tn);
    if (!norm || excelTns.has(norm)) continue;
    const type = String(s?.type || "").toUpperCase();
    if (type !== "LOADING" && type !== "UNLOADING") continue;

    const key = `${norm}|${type}`;
    const g = verifiedGps(s);
    const prev =
      groups.get(key) ||
      Object.assign(Object.create(null), {
        transport_number: tn,
        stop_type: type,
        arrival_iso: null,
        departure_iso: null,
        window_iso: null,
        window_end_iso: null,
        window_timezone: null,
        booking_location: null,
        plate: null,
      });

    prev.arrival_iso = earliest(prev.arrival_iso, g.arrival_iso);
    prev.departure_iso = latest(prev.departure_iso, g.departure_iso);
    prev.window_iso = prev.window_iso || s.timeslot_begin || null;
    prev.window_end_iso = prev.window_end_iso || s.timeslot_end || null;
    prev.window_timezone = prev.window_timezone || s.timeslot_timezone || null;
    prev.booking_location = prev.booking_location || s.booking_location || null;
    prev.plate = prev.plate || String(s.license_plate || "").trim() || null;
    groups.set(key, prev);
  }

  const addedStops = [];
  for (const g of groups.values()) {
    // Ohne verifizierte GPS-Zeit gibt es keinen Beleg -> nicht abrechnen.
    if (!g.arrival_iso && !g.departure_iso) continue;

    // Excel-Entladefenster ergaenzen, wenn Sixfold KEIN echtes Fenster liefert.
    // Ein ganztaegiges Platzhalter-Fenster (lokal 00:01) gilt NICHT als Fenster.
    // Vorhandenes echtes Sixfold-Fenster wird nie ersetzt; Ladestellen (LOADING)
    // nie aus der Excel gefuellt (dort ist immer ein Fenster vorhanden).
    const isPlaceholderWindow =
      g.stop_type === "UNLOADING" &&
      isPlaceholderTimeslot(g.window_iso, g.window_end_iso, g.window_timezone);
    const hasRealSixfoldWindow = Boolean(g.window_iso) && !isPlaceholderWindow;

    let windowIso = hasRealSixfoldWindow ? g.window_iso : null;
    let windowLocal = null;
    let windowFromExcel = false;
    if (g.stop_type === "UNLOADING" && !hasRealSixfoldWindow) {
      const ladenummer = transportNumberToLadenummer(g.transport_number);
      const windowRow =
        unloadWindowIndex && ladenummer
          ? unloadWindowIndex.get(ladenummer)
          : null;
      const unloadStart = windowStartForStop(windowRow, "UNLOADING");
      const refIso = g.arrival_iso || g.departure_iso;
      const built = unloadStart
        ? applyTimeToIsoDate(refIso, unloadStart)
        : null;
      if (built) {
        windowIso = built.iso;
        windowLocal = built.local;
        windowFromExcel = true;
        unloadWindowFromExcel += 1;
      }
      // Kein Excel-Treffer: windowIso bleibt null -> ab Ankunft zaehlen, kein
      // irrefuehrendes 00:01-Platzhalterfenster mehr.
    }

    const fee = computeStandgeld(
      {
        arrival_time: g.arrival_iso,
        departure_time: g.departure_iso,
        window_start: windowIso,
        transport_number: g.transport_number,
        stop_type: g.stop_type,
        arrival_gps_verified: Boolean(g.arrival_iso),
      },
      config,
    );

    addedStops.push(
      Object.freeze({
        ...fee,
        window_local: windowLocal,
        unload_window_fallback_applied: windowFromExcel,
        booking_location: g.booking_location || null,
        arrival_local: null,
        departure_local: null,
        timezone,
        excel_license_plate: null,
        gps_license_plate: g.plate,
        gps_plate_match: false,
        gps_checked: true,
        gps_available: true,
        gps_missing: false,
        arrival_source: g.arrival_iso ? "GPS" : null,
        departure_source: g.departure_iso ? "GPS" : null,
        arrival_time_used: g.arrival_iso,
        departure_time_used: g.departure_iso,
        xp_arrival_time: null,
        xp_departure_time: null,
        gps_arrival_time: g.arrival_iso,
        gps_departure_time: g.departure_iso,
        origin: "sixfold_only",
      }),
    );
  }

  const stops = baseStops.concat(addedStops);
  const chargeable = stops.filter((s) => !s.needs_review && s.fee_eur > 0);
  const review = stops.filter((s) => s.needs_review);
  const totalFee = stops.reduce(
    (sum, s) => sum + (s.needs_review ? 0 : s.fee_eur || 0),
    0,
  );

  // Zaehler muessen die ergaenzten Sixfold-Touren mitzaehlen, sonst zeigt die
  // reine Sixfold-Abrechnung faelschlich "0 Transporte" / "0 mit GPS".
  const addedTransportCount = new Set(
    addedStops
      .map((s) => String(s.transport_number || "").trim())
      .filter(Boolean),
  ).size;
  const gpsUsed = stops.filter(
    (s) => s.arrival_source === "GPS" || s.departure_source === "GPS",
  );
  const gpsUsedTransportCount = new Set(
    gpsUsed.map((s) => String(s.transport_number || "").trim()).filter(Boolean),
  ).size;
  const gpsMissing = stops.filter((s) => s.gps_missing);

  return {
    stops,
    summary: {
      ...baseSummary,
      transport_count:
        (Number(baseSummary.transport_count) || 0) + addedTransportCount,
      stop_count: stops.length,
      chargeable_count: chargeable.length,
      review_count: review.length,
      gps_checked: baseSummary.gps_checked || addedStops.length > 0,
      gps_used_count: gpsUsed.length,
      gps_used_transport_count: gpsUsedTransportCount,
      gps_missing_count: gpsMissing.length,
      sixfold_only_count: addedStops.length,
      sixfold_unload_window_from_excel: unloadWindowFromExcel,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = {
  appendSixfoldOnlyStops,
};
