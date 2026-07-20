"use strict";

/**
 * Stopp-Aufbau und Zeitfenster-Abgleich fuer Standgeld (Fakten, keine Gebuehr).
 *
 * Aus den Gegenpruef-Phasen (crossCheck.js) werden je (Transport, Lieferung)
 * konkrete Stopps gebildet:
 *   - LOADING   = LOAD_ARRIVAL + LOAD_DEPARTURE
 *   - UNLOADING = UNLOAD_ARRIVAL + UNLOAD_DEPARTURE
 * Pro Stopp wird die Standdauer (Abfahrt - Ankunft) aus den MASSGEBLICHEN
 * (authoritative) Zeiten berechnet und optional gegen ein Zeitfenster gestellt.
 *
 * WICHTIG (bewusst NICHT erfunden):
 * - Dieses Modul liefert nur nachvollziehbare FAKTEN (Dauer, Deltas zum Fenster).
 * - Die konkrete Standgeld-GEBUEHR (Freizeit/Karenz, Satz pro Zeiteinheit,
 *   Rundung, ab wann gezaehlt wird) ist eine fachliche Regel des Nutzers und
 *   wird hier NICHT angenommen.
 *
 * Reine, unit-testbare Funktionen (kein I/O).
 */

const { EVENT_CATEGORY } = require("./events");

const STOP_TYPE = Object.freeze({
  LOADING: "LOADING",
  UNLOADING: "UNLOADING",
});

function toEpoch(isoString) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? null : ms;
}

function minutesBetween(fromIso, toIso) {
  const a = toEpoch(fromIso);
  const b = toEpoch(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 60000);
}

/**
 * Waehlt fuer einen Stopp ein KONSISTENTES Quellenpaar (Ankunft + Abfahrt aus
 * derselben Messquelle). Das verhindert die haeufigste Fehlerquelle: Ankunft
 * aus TP-XP (Tag A) mit einer aus einem anderen Vorgang stammenden GPS-Abfahrt
 * (Tag C) zu kombinieren -> mehrtaegige Phantom-Standzeit.
 *
 * Prioritaet:
 *   1. Echtes GPS an BEIDEN Enden (verifizierte VisibilityHubUser-Koordinaten).
 *   2. TP-XP an BEIDEN Enden (saubere gepaarte Export-Ist-Zeiten).
 *   3. Gemischt/unvollstaendig -> massgebliche Zeit je Phase, aber Prueffall.
 *
 * @param {object|null} arrivalPhase
 * @param {object|null} departurePhase
 * @returns {{ source: string, arrivalTime: string|null, arrivalLocal: string|null,
 *   departureTime: string|null, departureLocal: string|null, mixedSources: boolean }}
 */
function selectConsistentTimes(arrivalPhase, departurePhase) {
  const aGps = Boolean(
    arrivalPhase &&
    arrivalPhase.visibility_gps_verified &&
    arrivalPhase.visibility_time,
  );
  const dGps = Boolean(
    departurePhase &&
    departurePhase.visibility_gps_verified &&
    departurePhase.visibility_time,
  );
  if (aGps && dGps) {
    return {
      source: "VISIBILITY",
      arrivalTime: arrivalPhase.visibility_time,
      arrivalLocal: arrivalPhase.visibility_local ?? null,
      departureTime: departurePhase.visibility_time,
      departureLocal: departurePhase.visibility_local ?? null,
      mixedSources: false,
    };
  }

  const aTp = arrivalPhase && arrivalPhase.tp_xp_time;
  const dTp = departurePhase && departurePhase.tp_xp_time;
  if (aTp && dTp) {
    return {
      source: "TP_XP",
      arrivalTime: arrivalPhase.tp_xp_time,
      arrivalLocal: arrivalPhase.tp_xp_local ?? null,
      departureTime: departurePhase.tp_xp_time,
      departureLocal: departurePhase.tp_xp_local ?? null,
      mixedSources: false,
    };
  }

  // Kein konsistentes Paar moeglich -> je Phase die massgebliche Zeit, aber der
  // Stopp ist ein Prueffall (die Endpunkte stammen ggf. aus verschiedenen
  // Quellen und sind nicht sicher vergleichbar).
  const arrivalTime = arrivalPhase ? arrivalPhase.authoritative_time : null;
  const departureTime = departurePhase
    ? departurePhase.authoritative_time
    : null;
  const arrivalSrc = arrivalPhase ? arrivalPhase.authoritative_source : null;
  const departureSrc = departurePhase
    ? departurePhase.authoritative_source
    : null;
  const mixedSources = Boolean(
    arrivalTime && departureTime && arrivalSrc !== departureSrc,
  );
  return {
    source: mixedSources ? "MIXED" : (arrivalSrc ?? departureSrc ?? null),
    arrivalTime,
    arrivalLocal: arrivalPhase
      ? (arrivalPhase.authoritative_local ?? null)
      : null,
    departureTime,
    departureLocal: departurePhase
      ? (departurePhase.authoritative_local ?? null)
      : null,
    mixedSources,
  };
}

/**
 * Baut einen Stopp aus Ankunfts- und Abfahrts-Phase.
 *
 * @param {string} stopType STOP_TYPE
 * @param {object|null} arrivalPhase Ergebnis aus crossCheck (oder null)
 * @param {object|null} departurePhase Ergebnis aus crossCheck (oder null)
 * @returns {object} eingefrorener Stopp
 */
function makeStop(stopType, arrivalPhase, departurePhase) {
  const ref = arrivalPhase || departurePhase || {};

  // Konsistentes Quellenpaar bestimmen (verhindert Quellen-Mix ueber Tage).
  const pair = selectConsistentTimes(arrivalPhase, departurePhase);
  const arrivalTime = pair.arrivalTime;
  const departureTime = pair.departureTime;

  const standingMinutes = minutesBetween(arrivalTime, departureTime);
  const negativeDuration = standingMinutes !== null && standingMinutes < 0;

  const incomplete = !arrivalTime || !departureTime;
  const multiVisit =
    Boolean(arrivalPhase && arrivalPhase.multi_visit) ||
    Boolean(departurePhase && departurePhase.multi_visit);
  const needsReview =
    Boolean(arrivalPhase && arrivalPhase.needs_review) ||
    Boolean(departurePhase && departurePhase.needs_review) ||
    incomplete ||
    negativeDuration ||
    pair.mixedSources ||
    multiVisit;

  const timezone =
    (arrivalPhase && arrivalPhase.timezone) ||
    (departurePhase && departurePhase.timezone) ||
    null;

  return Object.freeze({
    transport_number: ref.transport_number ?? null,
    delivery_number: ref.delivery_number ?? null,
    stop_type: stopType,

    arrival_time: arrivalTime,
    arrival_local: pair.arrivalLocal,
    arrival_source: pair.source,
    arrival_status: arrivalPhase ? arrivalPhase.status : null,

    departure_time: departureTime,
    departure_local: pair.departureLocal,
    departure_source: pair.source,
    departure_status: departurePhase ? departurePhase.status : null,

    timezone,
    standing_minutes: negativeDuration ? null : standingMinutes,
    incomplete,
    negative_duration: negativeDuration,
    mixed_sources: pair.mixedSources,
    multi_visit: multiVisit,
    needs_review: needsReview,
  });
}

/**
 * Bildet aus den Gegenpruef-Phasen konkrete Stopps.
 *
 * @param {Array<object>} phases - phases aus crossCheckEvents()
 * @returns {Array<object>} Stopps (LOADING vor UNLOADING je Lieferung)
 */
function buildStops(phases) {
  const map = new Map();
  const order = [];

  for (const phase of phases || []) {
    // Fachregel: pro Transport genau ein Lade- und ein Entladestopp. Nur nach
    // Transport gruppieren (Lieferungsnummer ist je Quelle uneinheitlich).
    const key = `${phase.transport_number ?? ""}`;
    if (!map.has(key)) {
      map.set(key, {});
      order.push(key);
    }
    map.get(key)[phase.phase] = phase;
  }

  const stops = [];
  for (const key of order) {
    const byPhase = map.get(key);
    if (
      byPhase[EVENT_CATEGORY.LOAD_ARRIVAL] ||
      byPhase[EVENT_CATEGORY.LOAD_DEPARTURE]
    ) {
      stops.push(
        makeStop(
          STOP_TYPE.LOADING,
          byPhase[EVENT_CATEGORY.LOAD_ARRIVAL] || null,
          byPhase[EVENT_CATEGORY.LOAD_DEPARTURE] || null,
        ),
      );
    }
    if (
      byPhase[EVENT_CATEGORY.UNLOAD_ARRIVAL] ||
      byPhase[EVENT_CATEGORY.UNLOAD_DEPARTURE]
    ) {
      stops.push(
        makeStop(
          STOP_TYPE.UNLOADING,
          byPhase[EVENT_CATEGORY.UNLOAD_ARRIVAL] || null,
          byPhase[EVENT_CATEGORY.UNLOAD_DEPARTURE] || null,
        ),
      );
    }
  }

  return stops;
}

/**
 * Stellt einen Stopp gegen ein Zeitfenster und liefert nachvollziehbare Fakten.
 * Erfindet KEINE Gebuehr -- nur Deltas und Dauern.
 *
 * @param {object} stop - aus buildStops()
 * @param {{ from?: string|null, to?: string|null }} [windowInput]
 * @returns {object} eingefrorene Faktenauswertung
 */
function compareWindow(stop, windowInput = {}) {
  const windowFrom = windowInput.from ?? null;
  const windowTo = windowInput.to ?? null;

  // Delta > 0 = spaeter als der Fensterpunkt.
  const arrivalVsFrom = minutesBetween(windowFrom, stop.arrival_time);
  const departureVsTo = minutesBetween(windowTo, stop.departure_time);

  // Reine Fakten: Wartezeit ueber das Fensterende hinaus (nicht = Gebuehr).
  const minutesAfterWindowEnd =
    departureVsTo !== null ? Math.max(0, departureVsTo) : null;

  const withinWindow =
    arrivalVsFrom !== null &&
    departureVsTo !== null &&
    arrivalVsFrom >= 0 &&
    departureVsTo <= 0;

  return Object.freeze({
    ...stop,
    window_from: windowFrom,
    window_to: windowTo,
    arrival_vs_window_from_minutes: arrivalVsFrom,
    departure_vs_window_to_minutes: departureVsTo,
    minutes_after_window_end: minutesAfterWindowEnd,
    within_window: withinWindow,
  });
}

module.exports = {
  STOP_TYPE,
  minutesBetween,
  makeStop,
  buildStops,
  compareWindow,
};
