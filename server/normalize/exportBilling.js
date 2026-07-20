"use strict";

/**
 * Standgeld-Abrechnung direkt aus dem Transporeon-Export (transporeonExport.js).
 *
 * Fuer JEDEN Transport werden beide Stopps (Laden/Entladen) einzeln bewertet:
 *   lokale Wanduhrzeit (Europe/Berlin) -> UTC -> computeStandgeld().
 * So bekommt jeder Transport eine nachvollziehbare Zeile; nichts geht unter.
 *
 * Reine Funktion (kein I/O).
 */

const { toUtcIso } = require("./datetime");
const { computeStandgeld } = require("./standgeld");

const DEFAULT_TZ = "Europe/Berlin";
const STOP_TYPES = Object.freeze([
  ["loading", "LOADING"],
  ["unloading", "UNLOADING"],
]);

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Ankunft: die FRUEHERE der beiden Zeiten ergibt die laengere Standzeit.
 * Nur echte Zeiten werden verglichen; fehlt eine, gewinnt die andere.
 */
function chooseArrival(xpIso, gpsIso) {
  const x = parseMs(xpIso);
  const g = parseMs(gpsIso);
  if (x !== null && g !== null) {
    return g < x
      ? { iso: gpsIso, source: "GPS" }
      : { iso: xpIso, source: "XP" };
  }
  if (g !== null) return { iso: gpsIso, source: "GPS" };
  if (x !== null) return { iso: xpIso, source: "XP" };
  return { iso: null, source: null };
}

/**
 * Abfahrt: die SPAETERE der beiden Zeiten ergibt die laengere Standzeit.
 */
function chooseDeparture(xpIso, gpsIso) {
  const x = parseMs(xpIso);
  const g = parseMs(gpsIso);
  if (x !== null && g !== null) {
    return g > x
      ? { iso: gpsIso, source: "GPS" }
      : { iso: xpIso, source: "XP" };
  }
  if (g !== null) return { iso: gpsIso, source: "GPS" };
  if (x !== null) return { iso: xpIso, source: "XP" };
  return { iso: null, source: null };
}

/**
 * Baut einen GPS-Index aus normalisierten Sixfold-Stopps (normalizeFleetStops).
 * Nur VERIFIZIERTE GPS-Zeiten (APPROACH/DEPART mit gueltigen Koordinaten) werden
 * uebernommen; geschaetzte (DEPART_UNKNOWN) oder 0/0-Faelle bleiben leer.
 *
 * @param {Array<object>} sixfoldStops
 * @returns {Map<string, {arrival_iso:string|null, departure_iso:string|null, present:boolean}>}
 *   Key "<transport_number>|LOADING" bzw. "|UNLOADING".
 */
function buildGpsIndex(sixfoldStops) {
  const index = new Map();
  for (const stop of sixfoldStops || []) {
    const tn = String(stop?.transport_number || "").trim();
    if (!tn) continue;
    const type = String(stop?.type || "").toUpperCase();
    const stopType = type === "LOADING" || type === "UNLOADING" ? type : null;
    if (!stopType) continue;

    const gps = stop.gps || {};
    const arrivalIso = gps.arrival_verified ? stop.arrival_time || null : null;
    const departureIso = gps.departure_verified
      ? stop.departure_time || null
      : null;

    const key = `${tn}|${stopType}`;
    const prev = index.get(key);
    // Mehrfachbesuch: frueheste Ankunft, spaeteste Abfahrt behalten.
    const merged = {
      arrival_iso: prev
        ? chooseArrival(prev.arrival_iso, arrivalIso).iso
        : arrivalIso,
      departure_iso: prev
        ? chooseDeparture(prev.departure_iso, departureIso).iso
        : departureIso,
      present: true,
    };
    index.set(key, merged);
  }
  return index;
}

/**
 * @param {Array<object>} transports - aus parseTransporeonExport()
 * @param {{ timezone?: string, config?: object, gpsIndex?: Map }} [options]
 * @returns {{ stops: Array<object>, summary: object }}
 */
function billFromExport(transports, options = {}) {
  const tz = options.timezone || DEFAULT_TZ;
  const config = options.config || {};
  const gpsIndex = options.gpsIndex instanceof Map ? options.gpsIndex : null;
  const gpsChecked = gpsIndex !== null;
  const stops = [];

  for (const t of transports || []) {
    for (const [field, stopType] of STOP_TYPES) {
      const stop = t[field];
      if (!stop) continue;

      const windowIso = toUtcIso(stop.window_local, tz);
      const xpArrivalIso = toUtcIso(stop.arrival_local, tz);
      const xpDepartureIso = toUtcIso(stop.departure_local, tz);

      const gpsEntry = gpsIndex
        ? gpsIndex.get(`${t.transport_number}|${stopType}`)
        : null;
      const gpsAvailable = Boolean(gpsEntry && gpsEntry.present);
      const gpsArrivalIso = gpsEntry ? gpsEntry.arrival_iso : null;
      const gpsDepartureIso = gpsEntry ? gpsEntry.departure_iso : null;

      // Mit GPS: laengere Zeit gewinnt (mehr Standgeld). Ohne GPS: XP-Zeit.
      const arrival = chooseArrival(xpArrivalIso, gpsArrivalIso);
      const departure = chooseDeparture(xpDepartureIso, gpsDepartureIso);

      const fee = computeStandgeld(
        {
          arrival_time: arrival.iso,
          departure_time: departure.iso,
          window_start: windowIso,
          transport_number: t.transport_number,
          stop_type: stopType,
        },
        config,
      );

      stops.push(
        Object.freeze({
          ...fee,
          window_local: stop.window_local,
          arrival_local: stop.arrival_local,
          departure_local: stop.departure_local,
          timezone: tz,
          // Wurde ueberhaupt eine GPS-Quelle abgefragt? Sonst "nicht geprueft".
          gps_checked: gpsChecked,
          gps_available: gpsAvailable,
          // "kein GPS" NUR wenn tatsaechlich geprueft und nichts gefunden.
          gps_missing: gpsChecked && !gpsAvailable,
          arrival_source: arrival.source,
          departure_source: departure.source,
          arrival_time_used: arrival.iso,
          departure_time_used: departure.iso,
          xp_arrival_time: xpArrivalIso,
          xp_departure_time: xpDepartureIso,
          gps_arrival_time: gpsArrivalIso,
          gps_departure_time: gpsDepartureIso,
        }),
      );
    }
  }

  const chargeable = stops.filter((s) => s.fee_eur > 0);
  const review = stops.filter((s) => s.needs_review);
  const gpsUsed = stops.filter(
    (s) => s.arrival_source === "GPS" || s.departure_source === "GPS",
  );
  const gpsMissing = stops.filter((s) => s.gps_missing);
  const totalFee = stops.reduce((sum, s) => sum + (s.fee_eur || 0), 0);

  return {
    stops,
    summary: {
      transport_count: (transports || []).length,
      stop_count: stops.length,
      chargeable_count: chargeable.length,
      review_count: review.length,
      gps_checked: gpsChecked,
      gps_used_count: gpsUsed.length,
      gps_missing_count: gpsMissing.length,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = {
  billFromExport,
  buildGpsIndex,
  chooseArrival,
  chooseDeparture,
};
