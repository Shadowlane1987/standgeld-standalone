"use strict";

/**
 * Sixfold-GPS-Verifikation fuer Standgeld.
 *
 * Grundlage: die von Sixfold gelieferten `status_events` je Stopp
 * (verifiziert an echten Daten, Company 799, 2026-07):
 *   - NAVIGATE       -> ETA/Routing, KEIN physischer Praesenz-Beweis
 *   - APPROACH       -> Fahrzeug hat den Geofence physisch betreten (GPS-Ankunft)
 *   - DEPART         -> Fahrzeug hat den Geofence physisch verlassen (GPS-Abfahrt)
 *   - DEPART_UNKNOWN -> Abfahrt nur geschaetzt, NICHT per GPS bestaetigt
 *   - SKIP           -> Stopp uebersprungen
 *
 * `arrival_time` entspricht der APPROACH-Zeit, `departure_time` der DEPART-Zeit.
 * `location.position{lat,lng}` ist der Geofence-Mittelpunkt (0/0 = ungueltig).
 *
 * Kernregeln (Arbeitsanweisung):
 * - Nur GPS-belegte Zeiten (APPROACH/DEPART mit gueltigen Koordinaten) gelten als
 *   belastbar. Eine Zeit ohne passendes GPS-Ereignis wird wie manuell behandelt
 *   und ist ein Prueffall (needs_review).
 * - DEPART_UNKNOWN beendet die Standzeit NICHT verlaesslich -> Prueffall.
 *
 * Reine Funktionen ohne Seiteneffekte -> voll unit-testbar.
 */

const { classifyCoordinatePair } = require("./coordinates");

const EVENT = Object.freeze({
  NAVIGATE: "NAVIGATE",
  APPROACH: "APPROACH",
  DEPART: "DEPART",
  DEPART_UNKNOWN: "DEPART_UNKNOWN",
  SKIP: "SKIP",
});

function normalizeEventName(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

/**
 * Klassifiziert einen einzelnen Sixfold-Stopp anhand seiner status_events und
 * seiner Geofence-Koordinaten.
 *
 * @param {object} stop Sixfold-Stopp (arrival_time, departure_time,
 *   location.position{lat,lng}, status_events[])
 * @returns {{
 *   gps_connected: boolean,
 *   arrival_verified: boolean,
 *   departure_verified: boolean,
 *   departure_estimated: boolean,
 *   coordinates: {verified:boolean, lat:number|null, lon:number|null, reason:string},
 *   event_names: string[],
 *   needs_review: boolean,
 *   flags: string[]
 * }}
 */
function classifySixfoldStop(stop) {
  const events = Array.isArray(stop?.status_events) ? stop.status_events : [];
  const names = events.map((event) => normalizeEventName(event?.event_name));

  const position = stop?.location?.position || null;
  const coordinates = classifyCoordinatePair(position?.lat, position?.lng);

  const hasApproach = names.includes(EVENT.APPROACH);
  const hasDepart = names.includes(EVENT.DEPART);
  const hasDepartUnknown = names.includes(EVENT.DEPART_UNKNOWN);

  // GPS gilt nur als angebunden, wenn ein physisches Praesenz-Ereignis vorliegt
  // UND die Geofence-Koordinaten gueltig sind. Reines NAVIGATE zaehlt nicht.
  const hasPresenceEvent = hasApproach || hasDepart || hasDepartUnknown;
  const gpsConnected = hasPresenceEvent && coordinates.verified;

  const arrivalVerified = hasApproach && coordinates.verified;
  const departureVerified = hasDepart && coordinates.verified;
  const departureEstimated = hasDepartUnknown && !hasDepart;

  const flags = [];
  if (!coordinates.verified) flags.push(`coordinates_${coordinates.reason}`);
  if (!hasPresenceEvent) flags.push("no_gps_presence_event");
  if (stop?.arrival_time && !arrivalVerified)
    flags.push("arrival_not_gps_verified");
  if (stop?.departure_time && !departureVerified) {
    flags.push(
      departureEstimated ? "departure_estimated" : "departure_not_gps_verified",
    );
  }

  const needsReview =
    !gpsConnected ||
    departureEstimated ||
    (Boolean(stop?.arrival_time) && !arrivalVerified) ||
    (Boolean(stop?.departure_time) && !departureVerified);

  return {
    gps_connected: gpsConnected,
    arrival_verified: arrivalVerified,
    departure_verified: departureVerified,
    departure_estimated: departureEstimated,
    coordinates: {
      verified: coordinates.verified,
      lat: coordinates.lat,
      lon: coordinates.lon,
      reason: coordinates.reason,
    },
    event_names: names,
    needs_review: needsReview,
    flags,
  };
}

module.exports = {
  EVENT,
  normalizeEventName,
  classifySixfoldStop,
};
