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
 * @param {Array<object>} transports - aus parseTransporeonExport()
 * @param {{ timezone?: string, config?: object }} [options]
 * @returns {{ stops: Array<object>, summary: object }}
 */
function billFromExport(transports, options = {}) {
  const tz = options.timezone || DEFAULT_TZ;
  const config = options.config || {};
  const stops = [];

  for (const t of transports || []) {
    for (const [field, stopType] of STOP_TYPES) {
      const stop = t[field];
      if (!stop) continue;

      const windowIso = toUtcIso(stop.window_local, tz);
      const arrivalIso = toUtcIso(stop.arrival_local, tz);
      const departureIso = toUtcIso(stop.departure_local, tz);

      const fee = computeStandgeld(
        {
          arrival_time: arrivalIso,
          departure_time: departureIso,
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
        }),
      );
    }
  }

  const chargeable = stops.filter((s) => s.fee_eur > 0);
  const review = stops.filter((s) => s.needs_review);
  const totalFee = stops.reduce((sum, s) => sum + (s.fee_eur || 0), 0);

  return {
    stops,
    summary: {
      transport_count: (transports || []).length,
      stop_count: stops.length,
      chargeable_count: chargeable.length,
      review_count: review.length,
      total_fee_eur: totalFee,
    },
  };
}

module.exports = { billFromExport };
