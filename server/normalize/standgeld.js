"use strict";

/**
 * Standgeld-Gebuehrenberechnung (Nutzer-Regel, 2026-07-17).
 *
 * Regeln:
 * 1. Freizeit: 2 h (120 min) sind frei.
 * 2. Zaehlbeginn IMMER ab Zeitfenster; bei spaeterer Ankunft ab Ankunftszeit.
 *    Wartezeit VOR dem Fenster wird NIE gezaehlt -> count_start = max(Fenster, Ankunft).
 * 3. Ausloese-Schwelle: erst ab 10 min ueber der Freizeit wird abgerechnet
 *    (2 h 09 = 0 EUR, ab 2 h 10 = erste Stufe).
 * 4. Danach je ANGEFANGENE 30 min = 30 EUR (aufgerundete Bloecke).
 * 5. Fensterzeit = erste Zeit des Slots (z.B. 06:00-06:15 -> 06:00). Die Auswahl
 *    der Fensterquelle (Transporeon-Slot bzw. Excel bei fehlendem Entladefenster)
 *    erfolgt UPSTREAM; hier wird nur window_start konsumiert.
 *
 * Reine, unit-testbare Funktion (kein I/O). Es wird nichts erfunden: fehlen
 * Ankunft, Abfahrt oder Fenster, ist der Fall NICHT berechenbar (Prueffall).
 */

const DEFAULT_CONFIG = Object.freeze({
  freeMinutes: 120, // 2 h frei
  triggerMinutes: 10, // erst ab 10 min ueber Freizeit
  blockMinutes: 30, // Taktung: angefangene 30 min
  blockRateEur: 30, // 30 EUR je angefangenem Block
});

const REASON = Object.freeze({
  MISSING_DATA: "missing_data",
  WITHIN_FREE: "within_free_time",
  BELOW_TRIGGER: "below_trigger",
  CHARGEABLE: "chargeable",
});

function toEpoch(isoString) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Berechnet das Standgeld fuer einen Stopp.
 *
 * @param {{
 *   arrival_time?: string|null,
 *   departure_time?: string|null,
 *   window_start?: string|null,
 *   needs_review?: boolean,
 *   transport_number?: string|null,
 *   delivery_number?: string|null,
 *   stop_type?: string|null
 * }} input
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @returns {object} eingefrorenes Ergebnis
 */
function computeStandgeld(input = {}, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const arrival = toEpoch(input.arrival_time);
  const departure = toEpoch(input.departure_time);
  const windowStart = toEpoch(input.window_start);

  const base = {
    transport_number: input.transport_number ?? null,
    delivery_number: input.delivery_number ?? null,
    stop_type: input.stop_type ?? null,
    arrival_time: input.arrival_time ?? null,
    departure_time: input.departure_time ?? null,
    window_start: input.window_start ?? null,
    free_minutes: cfg.freeMinutes,
    block_minutes: cfg.blockMinutes,
    block_rate_eur: cfg.blockRateEur,
  };

  // Ohne vollstaendige Zeiten nicht berechenbar -> Prueffall.
  if (arrival === null || departure === null || windowStart === null) {
    return Object.freeze({
      ...base,
      arrived_late: null,
      count_start: null,
      counted_standing_minutes: null,
      minutes_over_free: null,
      billable_blocks: 0,
      fee_eur: 0,
      chargeable: false,
      reason: REASON.MISSING_DATA,
      needs_review: true,
    });
  }

  const arrivedLate = arrival > windowStart;

  // Regel 2: Zaehlbeginn ab Fenster, bei Spaetankunft ab Ankunft.
  // Wartezeit vor dem Fenster wird nie gezaehlt.
  const countStartMs = Math.max(windowStart, arrival);
  const countStart = new Date(countStartMs).toISOString();

  let countedMinutes = Math.round((departure - countStartMs) / 60000);
  if (countedMinutes < 0) countedMinutes = 0;

  const rawOverrun = countedMinutes - cfg.freeMinutes;

  let reason;
  let blocks = 0;
  let feeEur = 0;
  let chargeable = false;

  if (rawOverrun < 0) {
    reason = REASON.WITHIN_FREE;
  } else if (rawOverrun < cfg.triggerMinutes) {
    reason = REASON.BELOW_TRIGGER;
  } else {
    // Regel 4: angefangene Bloecke aufrunden.
    blocks = Math.ceil(rawOverrun / cfg.blockMinutes);
    feeEur = blocks * cfg.blockRateEur;
    chargeable = true;
    reason = REASON.CHARGEABLE;
  }

  return Object.freeze({
    ...base,
    arrived_late: arrivedLate,
    count_start: countStart,
    counted_standing_minutes: countedMinutes,
    minutes_over_free: Math.max(0, rawOverrun),
    billable_blocks: blocks,
    fee_eur: feeEur,
    chargeable,
    reason,
    // Prueffall, wenn die Zeitbasis nicht belegbar war (aus dem Stopp uebernommen).
    needs_review: Boolean(input.needs_review),
  });
}

module.exports = {
  DEFAULT_CONFIG,
  REASON,
  computeStandgeld,
};
