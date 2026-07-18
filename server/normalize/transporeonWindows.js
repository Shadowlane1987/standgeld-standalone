"use strict";

/**
 * Wandelt normalisierte Transporeon-Buchungen (bookings.js) in eine Fenster-Map
 * fuer die Abrechnung (billing.js) um.
 *
 * Fachregel (Nutzer): Die Ladestelle hat in Transporeon IMMER ein Zeitfenster
 * (Slot-Start = window_from). Dieses ist die PRIMAERE Fensterquelle fuer den
 * Ladestopp. Das Entladefenster fehlt in Transporeon oft -> dort greift der
 * Excel-Fallback (siehe billing.js).
 *
 * Ausgabe: Map mit Schluessel "<transport_number>|LOADING" -> "HH:MM"
 * (erste/Startzeit des Slots in der lokalen Zeitzone des Standorts).
 *
 * Reine, unit-testbare Funktionen (kein I/O).
 */

const { isValidTimeZone } = require("./datetime");

/**
 * Formatiert einen UTC-Zeitpunkt als lokale "HH:MM" in der angegebenen Zone.
 *
 * @param {string} utcIso
 * @param {string|null} timeZone
 * @returns {string|null}
 */
function localTimeInZone(utcIso, timeZone) {
  const ms = Date.parse(String(utcIso || ""));
  if (Number.isNaN(ms)) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));

  const map = {};
  for (const part of parts) map[part.type] = part.value;
  if (map.hour == null || map.minute == null) return null;
  return `${map.hour}:${map.minute}`;
}

/**
 * Baut die Transporeon-Fenster-Map fuer die Ladestopps aus Buchungen.
 * Die erste Buchung je Transport gewinnt.
 *
 * @param {Array<object>} bookings - aus parseBookingsResponse().bookings
 * @param {{ stopType?: string }} [options]
 * @returns {Map<string, string>} Key "<transport>|<STOPTYPE>" -> "HH:MM"
 */
function bookingsToWindowMap(bookings, options = {}) {
  const stopType = options.stopType || "LOADING";
  const map = new Map();

  for (const booking of bookings || []) {
    const transport = booking && booking.transport_number;
    if (!transport) continue;

    const key = `${transport}|${stopType}`;
    if (map.has(key)) continue;

    const time = localTimeInZone(
      booking.window_from_iso,
      booking.location_timezone,
    );
    if (time) map.set(key, time);
  }

  return map;
}

module.exports = {
  localTimeInZone,
  bookingsToWindowMap,
};
