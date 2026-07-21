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

/**
 * Normalisiere Transport-Numbers für Matching.
 * Excel: "2M_20260715_0006638489" → "0006638489"
 * Sixfold: "0006638489" → "0006638489"
 * Diese Funktion extrahiert die LETZTE 10-stellige Nummer.
 */
function normalizeTransportNumber(tn) {
  if (!tn) return "";
  const str = String(tn).trim();
  // Suche nach 10-stelligen Nummern am Ende (üblicherweise die Transport-ID)
  const match = str.match(/(\d{10})$/);
  return match ? match[1] : str;
}

function normalizeLicensePlate(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function standingMinutes(arrivalIso, departureIso) {
  const a = parseMs(arrivalIso);
  const d = parseMs(departureIso);
  if (a === null || d === null) return null;
  return (d - a) / 60000;
}

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
 * Nur echte Zeiten werden verglichen; fehlt eine, gewinnt die andere.
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
 * @param {object} [options] { debug: boolean }
 * @returns {Map<string, {arrival_iso:string|null, departure_iso:string|null, present:boolean}>}
 *   Key "<transport_number>|LOADING" bzw. "|UNLOADING".
 */
function buildGpsIndex(sixfoldStops, options = {}) {
  const index = new Map();
  const debug = Boolean(options.debug);
  const diagnostics = {
    total: 0,
    filtered: 0,
    zeroCoords: 0,
    noVerify: 0,
    matched: 0,
    licensePlateMatched: 0,
    licensePlateMissing: 0,
  };

  for (const stop of sixfoldStops || []) {
    diagnostics.total++;
    const tn = String(stop?.transport_number || "").trim();
    if (!tn) continue;
    const licensePlate = String(stop?.license_plate || "").trim() || null;
    const type = String(stop?.type || "").toUpperCase();
    const stopType = type === "LOADING" || type === "UNLOADING" ? type : null;
    if (!stopType) continue;

    const gps = stop.gps || {};
    const coords = stop?.position || {};
    const lat = Number(coords.lat) || 0;
    const lng = Number(coords.lng) || 0;
    const hasZeroCoords = lat === 0 && lng === 0;

    const arrivalVerified = gps.arrival_verified && !hasZeroCoords;
    const departureVerified = gps.departure_verified && !hasZeroCoords;

    if (hasZeroCoords) diagnostics.zeroCoords++;
    if (!arrivalVerified && !departureVerified) diagnostics.noVerify++;

    const arrivalIso = arrivalVerified ? stop.arrival_time || null : null;
    const departureIso = departureVerified ? stop.departure_time || null : null;

    // Nur wenn MINDESTENS eine Zeit verifiziert ist, in den Index.
    if (!arrivalIso && !departureIso) {
      diagnostics.filtered++;
      continue;
    }

    diagnostics.matched++;
    if (licensePlate) diagnostics.licensePlateMatched++;
    else diagnostics.licensePlateMissing++;

    // Bevorzugt wird exaktes Matching ueber die volle Transportnummer.
    // Fallback ist die normalisierte Endnummer, aber nur wenn eindeutig.
    const normalizedTn = normalizeTransportNumber(tn);
    const exactKey = `EXACT:${tn}|${stopType}`;
    const normKey = `NORM:${normalizedTn}|${stopType}`;

    const mergeEntry = (prev) => {
      const sourceList = Array.isArray(prev?.source_transport_numbers)
        ? prev.source_transport_numbers
        : [];
      const nextSources = sourceList.includes(tn)
        ? sourceList
        : [...sourceList, tn];
      return {
        arrival_iso: prev
          ? chooseArrival(prev.arrival_iso, arrivalIso).iso
          : arrivalIso,
        departure_iso: prev
          ? chooseDeparture(prev.departure_iso, departureIso).iso
          : departureIso,
        license_plate: prev?.license_plate || licensePlate,
        source_transport_numbers: nextSources,
        ambiguous_match: nextSources.length > 1,
        present: true,
      };
    };

    index.set(exactKey, mergeEntry(index.get(exactKey)));
    index.set(normKey, mergeEntry(index.get(normKey)));

    if (debug && hasZeroCoords) {
      console.log(
        `[GPS-DEBUG] 0/0-Koordinaten: ${normKey} (arrival_verified=${arrivalVerified}, departure_verified=${departureVerified})`,
      );
    }
  }

  if (debug) {
    console.log(`[GPS-INDEX] Diagnostik:`, diagnostics);
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

      // GPS-Matching: zuerst exakte Transportnummer, dann normalisiert (nur eindeutig).
      const exactTn = String(t.transport_number || "").trim();
      const normalizedTn = normalizeTransportNumber(t.transport_number);
      let gpsEntry = null;
      if (gpsIndex) {
        gpsEntry = gpsIndex.get(`EXACT:${exactTn}|${stopType}`) || null;
        if (!gpsEntry) {
          const fallback =
            gpsIndex.get(`NORM:${normalizedTn}|${stopType}`) || null;
          gpsEntry = fallback && !fallback.ambiguous_match ? fallback : null;
        }
      }

      // GPS ist nur verfügbar wenn:
      // 1) Sixfold-Eintrag vorhanden
      // 2) Excel-Kennzeichen vorhanden
      // 3) Sixfold-Kennzeichen vorhanden
      // 4) Kennzeichen identisch (normalisiert)
      //
      // WICHTIG: Wenn TN stimmt aber Kennzeichen NICHT -> trotzdem abrechnen mit XP-Zeiten!
      // (chooseArrival/chooseDeparture nehmen automatisch XP wenn kein GPS verfuegbar)
      const excelLicensePlate = (t.vehicle_registration || "").trim() || null;
      const sixfoldLicensePlate = gpsEntry?.license_plate || null;

      const hasExcelPlate = Boolean(excelLicensePlate);
      const hasSixfoldPlate = Boolean(sixfoldLicensePlate);
      const licensePlateValid =
        hasExcelPlate &&
        hasSixfoldPlate &&
        normalizeLicensePlate(sixfoldLicensePlate) ===
          normalizeLicensePlate(excelLicensePlate);

      const gpsAvailable = Boolean(
        gpsEntry && gpsEntry.present && licensePlateValid,
      );

      const gpsArrivalIso = gpsAvailable ? gpsEntry?.arrival_iso : null;
      const gpsDepartureIso = gpsAvailable ? gpsEntry?.departure_iso : null;

      // Pro Grenze die laengere Standzeit waehlen (dokumentierte Nutzer-Regel):
      // Ankunft = FRUEHESTE aus {XP, verifiziertes GPS}
      // Abfahrt = SPAETESTE aus {XP, verifiziertes GPS}
      // So wird der echte Standzeit-Zeitraum erfasst, auch bei Mehrfachbesuch/
      // Pause (z.B. GPS-Ankunft frueh, XP-Abfahrt spaet nach der Ruhezeit).
      const arrivalChoice = chooseArrival(xpArrivalIso, gpsArrivalIso);
      const departureChoice = chooseDeparture(xpDepartureIso, gpsDepartureIso);

      const fee = computeStandgeld(
        {
          arrival_time: arrivalChoice.iso,
          departure_time: departureChoice.iso,
          window_start: windowIso,
          transport_number: t.transport_number,
          stop_type: stopType,
          // Signalisiert der Regel-Engine, dass die verwendete Ankunft GPS-belegt
          // ist -> ermoeglicht den Umbuchungs-/Pausefall (ab GPS-Ankunft zaehlen).
          arrival_gps_verified: arrivalChoice.source === "GPS",
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
          excel_license_plate: excelLicensePlate,
          gps_license_plate: sixfoldLicensePlate,
          gps_plate_match: licensePlateValid,
          // Wurde ueberhaupt eine GPS-Quelle abgefragt? Sonst "nicht geprueft".
          gps_checked: gpsChecked,
          gps_available: gpsAvailable,
          // "kein GPS" NUR wenn tatsaechlich geprueft und nichts gefunden.
          gps_missing: gpsChecked && !gpsAvailable,
          arrival_source: arrivalChoice.source,
          departure_source: departureChoice.source,
          arrival_time_used: arrivalChoice.iso,
          departure_time_used: departureChoice.iso,
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
  const gpsUsedTransportCount = new Set(
    gpsUsed.map((s) => String(s.transport_number || "").trim()).filter(Boolean),
  ).size;
  const mixedSourceCount = stops.filter(
    (s) => s.arrival_source !== s.departure_source,
  ).length;
  const gpsMissing = stops.filter((s) => s.gps_missing);
  const rebookingSuspectedCount = stops.filter(
    (s) => s.rebooking_suspected,
  ).length;
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
      gps_used_transport_count: gpsUsedTransportCount,
      gps_missing_count: gpsMissing.length,
      mixed_source_count: mixedSourceCount,
      rebooking_suspected_count: rebookingSuspectedCount,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = {
  billFromExport,
  buildGpsIndex,
  chooseArrival,
  chooseDeparture,
  normalizeTransportNumber,
  normalizeLicensePlate,
};
