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

const DEFAULT_TZ = "Europe/Berlin";

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
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
        booking_location: null,
        plate: null,
      });

    prev.arrival_iso = earliest(prev.arrival_iso, g.arrival_iso);
    prev.departure_iso = latest(prev.departure_iso, g.departure_iso);
    prev.window_iso = prev.window_iso || s.timeslot_begin || null;
    prev.booking_location = prev.booking_location || s.booking_location || null;
    prev.plate = prev.plate || String(s.license_plate || "").trim() || null;
    groups.set(key, prev);
  }

  const addedStops = [];
  for (const g of groups.values()) {
    // Ohne verifizierte GPS-Zeit gibt es keinen Beleg -> nicht abrechnen.
    if (!g.arrival_iso && !g.departure_iso) continue;

    const fee = computeStandgeld(
      {
        arrival_time: g.arrival_iso,
        departure_time: g.departure_iso,
        window_start: g.window_iso,
        transport_number: g.transport_number,
        stop_type: g.stop_type,
        arrival_gps_verified: Boolean(g.arrival_iso),
      },
      config,
    );

    addedStops.push(
      Object.freeze({
        ...fee,
        window_local: null,
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

  return {
    stops,
    summary: {
      ...baseSummary,
      stop_count: stops.length,
      chargeable_count: chargeable.length,
      review_count: review.length,
      sixfold_only_count: addedStops.length,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = {
  appendSixfoldOnlyStops,
};
