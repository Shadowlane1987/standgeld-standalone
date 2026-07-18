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
 * Baut einen Stopp aus Ankunfts- und Abfahrts-Phase.
 *
 * @param {string} stopType STOP_TYPE
 * @param {object|null} arrivalPhase Ergebnis aus crossCheck (oder null)
 * @param {object|null} departurePhase Ergebnis aus crossCheck (oder null)
 * @returns {object} eingefrorener Stopp
 */
function makeStop(stopType, arrivalPhase, departurePhase) {
  const ref = arrivalPhase || departurePhase || {};
  const arrivalTime = arrivalPhase ? arrivalPhase.authoritative_time : null;
  const departureTime = departurePhase
    ? departurePhase.authoritative_time
    : null;

  const standingMinutes = minutesBetween(arrivalTime, departureTime);
  const negativeDuration = standingMinutes !== null && standingMinutes < 0;

  const incomplete = !arrivalTime || !departureTime;
  const needsReview =
    Boolean(arrivalPhase && arrivalPhase.needs_review) ||
    Boolean(departurePhase && departurePhase.needs_review) ||
    incomplete ||
    negativeDuration;

  const timezone =
    (arrivalPhase && arrivalPhase.timezone) ||
    (departurePhase && departurePhase.timezone) ||
    null;

  return Object.freeze({
    transport_number: ref.transport_number ?? null,
    delivery_number: ref.delivery_number ?? null,
    stop_type: stopType,

    arrival_time: arrivalTime,
    arrival_local: arrivalPhase
      ? (arrivalPhase.authoritative_local ?? null)
      : null,
    arrival_source: arrivalPhase ? arrivalPhase.authoritative_source : null,
    arrival_status: arrivalPhase ? arrivalPhase.status : null,

    departure_time: departureTime,
    departure_local: departurePhase
      ? (departurePhase.authoritative_local ?? null)
      : null,
    departure_source: departurePhase
      ? departurePhase.authoritative_source
      : null,
    departure_status: departurePhase ? departurePhase.status : null,

    timezone,
    standing_minutes: negativeDuration ? null : standingMinutes,
    incomplete,
    negative_duration: negativeDuration,
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
