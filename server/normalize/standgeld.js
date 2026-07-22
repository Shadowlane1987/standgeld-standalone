"use strict";

/**
 * Standgeld-Gebuehrenberechnung (Nutzer-Regel, 2026-07-17).
 *
 * Regeln:
 * 1. Freizeit: 2 h (120 min) sind frei.
 * 2. Normalfall: Zaehlbeginn ab Zeitfenster; bei spaeterer Ankunft ab Ankunftszeit.
 *    Mit aktivierter Verspätungsregel gilt bei Spaetankunft stattdessen
 *    3 h freie Zeit ab der Ankunft.
 * 3. Ausloese-Schwelle: erst ab 10 min ueber der Freizeit wird abgerechnet
 *    (2 h 09 = 0 EUR, ab 2 h 10 = erste Stufe).
 * 4. Danach je ANGEFANGENE 30 min = 30 EUR (aufgerundete Bloecke).
 * 5. Fensterzeit = erste Zeit des Slots (z.B. 06:00-06:15 -> 06:00). Die Auswahl
 *    der Fensterquelle (Transporeon-Slot bzw. Excel bei fehlendem Entladefenster)
 *    erfolgt UPSTREAM; hier wird nur window_start konsumiert.
 * 6. Obergrenze: pro Stopp werden NIE mehr als 650 EUR abgerechnet (maxFeeEur).
 *    Die ungedeckelten Bloecke bleiben zur Nachvollziehbarkeit sichtbar; fee_capped
 *    markiert, dass gedeckelt wurde.
 * 7. Plausibilitaet: eine Standzeit ueber maxPlausibleMinutes (24 h) ist fast immer
 *    ein Datenfehler (z.B. falsch gematchte Ankunft/Abfahrt an verschiedenen Tagen).
 *    Solche Faelle werden NICHT automatisch abgerechnet, sondern als Prueffall
 *    gefuehrt (lieber Prueffall als Falschabrechnung).
 *
 * Reine, unit-testbare Funktion (kein I/O). Es wird nichts erfunden: fehlen
 * Ankunft, Abfahrt oder Fenster, ist der Fall NICHT berechenbar (Prueffall).
 */

const DEFAULT_CONFIG = Object.freeze({
  freeMinutes: 120, // 2 h frei
  triggerMinutes: 10, // erst ab 10 min ueber Freizeit
  blockMinutes: 30, // Taktung: angefangene 30 min
  blockRateEur: 30, // 30 EUR je angefangenem Block
  maxFeeEur: 650, // Obergrenze: mehr als 650 EUR wird nie abgerechnet
  maxPlausibleMinutes: 1440, // > 24 h Standzeit = unplausibel -> Prueffall
  rebookingGapMinutes: 360, // GPS-Ankunft >= 6 h vor Fenster -> Umbuchungs-/Pausefall
  lateArrivalGraceEnabled: false,
  lateArrivalGraceMinutes: 45,
});

const REASON = Object.freeze({
  MISSING_DATA: "missing_data",
  WITHIN_FREE: "within_free_time",
  BELOW_TRIGGER: "below_trigger",
  CHARGEABLE: "chargeable",
  IMPLAUSIBLE_DURATION: "implausible_duration",
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
  let effectiveFreeMinutes = cfg.freeMinutes;

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
    free_minutes: effectiveFreeMinutes,
    block_minutes: cfg.blockMinutes,
    block_rate_eur: cfg.blockRateEur,
    max_fee_eur: cfg.maxFeeEur,
  };

  // Ohne vollstaendige Zeiten nicht berechenbar -> Prueffall.
  if (arrival === null || departure === null || windowStart === null) {
    return Object.freeze({
      ...base,
      arrived_late: null,
      count_start: null,
      counted_standing_minutes: null,
      effective_standing_minutes: null,
      minutes_over_free: null,
      rest_time_deducted: false,
      billable_blocks: 0,
      fee_eur: 0,
      fee_capped: false,
      chargeable: false,
      reason: REASON.MISSING_DATA,
      needs_review: true,
      rebooking_suspected: false,
    });
  }

  const arrivedLate = arrival > windowStart;
  const lateGraceEnabled = Boolean(cfg.lateArrivalGraceEnabled);
  const lateGraceMinutes = Math.max(
    0,
    Number.isFinite(Number(cfg.lateArrivalGraceMinutes))
      ? Number(cfg.lateArrivalGraceMinutes)
      : DEFAULT_CONFIG.lateArrivalGraceMinutes,
  );

  // Sonderfall Umbuchung/Pause: Geht ein LKW in die Pause, wird das Zeitfenster
  // umgebucht (neues, spaeteres Fenster). Die echte Standzeit begann aber schon
  // bei der physischen Ankunft. Liegt eine GPS-BELEGTE Ankunft deutlich (>= rebooking-
  // GapMinutes) VOR dem Fenster, zaehlen wir ab der echten Ankunft statt ab dem
  // umgebuchten Fenster - und fuehren den Fall als Prueffall (needs_review).
  // Nur mit GPS-Beleg; ohne GPS bleibt es beim Fenster (konservativ).
  const earlyGapMs = windowStart - arrival; // > 0 wenn Ankunft vor Fenster
  const rebookingSuspected =
    input.arrival_gps_verified === true &&
    cfg.rebookingGapMinutes != null &&
    earlyGapMs >= cfg.rebookingGapMinutes * 60000;

  // Regel 2: Zaehlbeginn ab Fenster, bei Spaetankunft ab Ankunft.
  // Wartezeit vor dem Fenster wird nie gezaehlt - AUSSER im Umbuchungsfall.
  // Mit aktivierter Verspaetungsregel gilt fuer alle Spaetankuenfte 3h frei.
  const lateGraceApplies = lateGraceEnabled && arrivedLate;

  const freeMinutesForCharge = lateGraceApplies ? 180 : cfg.freeMinutes;
  effectiveFreeMinutes = freeMinutesForCharge;
  const countStartMs =
    rebookingSuspected || lateGraceApplies
      ? arrival
      : Math.max(windowStart, arrival);
  const countStart = new Date(countStartMs).toISOString();

  let countedMinutes = Math.round((departure - countStartMs) / 60000);
  if (countedMinutes < 0) countedMinutes = 0;

  // Regel 7b: Ruhezeit automatisch abziehen (gesetzliche 9h Ruhe bei Langfahrten).
  // Wenn Standzeit > 12h, wird 9h (540 min) als Ruhezeit abgezogen.
  // Nutzer-Vorgabe 2026-07-20: keine Multi-Visit-Probleme erwartet, daher
  // automatisch abziehen statt zu pruefen.
  const REST_TIME_THRESHOLD_MIN = 12 * 60; // 12 Stunden
  const REST_TIME_DEDUCTION_MIN = 9 * 60; // 9 Stunden
  let effectiveMinutes = countedMinutes;
  let restTimeDeducted = false;
  if (countedMinutes > REST_TIME_THRESHOLD_MIN) {
    effectiveMinutes = countedMinutes - REST_TIME_DEDUCTION_MIN;
    restTimeDeducted = true;
    if (effectiveMinutes < 0) effectiveMinutes = 0;
  }

  // Regel 7: unplausibel lange Standzeit (> 24 h) nicht automatisch abrechnen.
  if (
    cfg.maxPlausibleMinutes != null &&
    countedMinutes > cfg.maxPlausibleMinutes
  ) {
    return Object.freeze({
      ...base,
      arrived_late: arrivedLate,
      count_start: countStart,
      counted_standing_minutes: countedMinutes,
      minutes_over_free: Math.max(0, countedMinutes - freeMinutesForCharge),
      effective_standing_minutes: effectiveMinutes,
      rest_time_deducted: restTimeDeducted,
      billable_blocks: 0,
      fee_eur: 0,
      fee_capped: false,
      chargeable: false,
      reason: REASON.IMPLAUSIBLE_DURATION,
      needs_review: true,
      rebooking_suspected: rebookingSuspected,
    });
  }

  const rawOverrun = effectiveMinutes - freeMinutesForCharge;

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

  // Regel 6: Obergrenze - nie mehr als maxFeeEur abrechnen.
  let feeCapped = false;
  if (cfg.maxFeeEur != null && feeEur > cfg.maxFeeEur) {
    feeEur = cfg.maxFeeEur;
    feeCapped = true;
  }

  return Object.freeze({
    ...base,
    free_minutes: effectiveFreeMinutes,
    arrived_late: arrivedLate,
    count_start: countStart,
    counted_standing_minutes: countedMinutes,
    effective_standing_minutes: effectiveMinutes,
    minutes_over_free: Math.max(0, rawOverrun),
    rest_time_deducted: restTimeDeducted,
    billable_blocks: blocks,
    fee_eur: feeEur,
    fee_capped: feeCapped,
    chargeable,
    reason,
    // Prueffall, wenn die Zeitbasis nicht belegbar war (aus dem Stopp uebernommen)
    // ODER wenn wegen Umbuchung ab der GPS-Ankunft statt ab dem Fenster gezaehlt wird.
    needs_review: Boolean(input.needs_review) || rebookingSuspected,
    rebooking_suspected: rebookingSuspected,
    late_arrival_grace_enabled: lateGraceEnabled,
    late_arrival_grace_minutes: lateGraceMinutes,
    late_arrival_grace_applied: lateGraceApplies,
  });
}

module.exports = {
  DEFAULT_CONFIG,
  REASON,
  computeStandgeld,
};
