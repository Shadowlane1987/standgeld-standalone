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
  lateArrivalGraceEnabled: false,
  lateArrivalGraceMinutes: 45,
  // Regel 8 (Nutzer 2026-08-05): Standzeit, die eine Nachtruhe oder ein
  // Wochenende einschliesst, ist meist keine reale Wartezeit (LKW macht Pause /
  // Yard geschlossen). Solche Faelle werden als Prueffall markiert und NICHT in
  // die Gesamtsumme genommen.
  restReviewEnabled: true,
  nightRestBandStartHour: 21, // Nacht-Band Beginn (Berliner Zeit)
  nightRestBandEndHour: 6, // Nacht-Band Ende (naechster Morgen)
  nightRestReviewMinutes: 240, // ab 4 h Nachtueberlappung -> Prueffall
  weekendReviewMinutes: 240, // ab 4 h Ueberlappung mit Sa/So -> Prueffall
});

const REASON = Object.freeze({
  MISSING_DATA: "missing_data",
  WITHIN_FREE: "within_free_time",
  BELOW_TRIGGER: "below_trigger",
  CHARGEABLE: "chargeable",
  IMPLAUSIBLE_DURATION: "implausible_duration",
  REST_PERIOD_INCLUDED: "rest_period_included",
});

function toEpoch(isoString) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? null : ms;
}

// Wandelt einen Zeitpunkt (Epoch) in eine "Wanduhr-Epoch" um, bei der die
// UTC-Methoden die Berliner Ortszeit liefern. So lassen sich Nacht-/Wochenend-
// Fenster ueber Tagesgrenzen hinweg robust und ohne DST-Sonderfaelle rechnen.
const BERLIN_TZ = "Europe/Berlin";
let berlinFormatter = null;
function berlinWallEpoch(epochMs) {
  if (epochMs == null || Number.isNaN(epochMs)) return null;
  if (!berlinFormatter) {
    berlinFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: BERLIN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  const p = {};
  for (const part of berlinFormatter.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  let hour = Number(p.hour);
  if (hour === 24) hour = 0;
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return e > s ? (e - s) / 60000 : 0;
}

// Ermittelt, wie viele Minuten des gezaehlten Zeitraums in eine Nachtruhe bzw.
// auf ein Wochenende (Sa/So) fallen.
function restReviewOverlap(countStartMs, departureMs, cfg) {
  const wallStart = berlinWallEpoch(countStartMs);
  const wallEnd = berlinWallEpoch(departureMs);
  if (wallStart == null || wallEnd == null || !(wallEnd > wallStart)) {
    return { nightMinutes: 0, weekendMinutes: 0 };
  }
  const dayMs = 86400000;
  const first = new Date(wallStart);
  let cursor =
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()) -
    dayMs;
  let nightMinutes = 0;
  let weekendMinutes = 0;
  for (; cursor <= wallEnd; cursor += dayMs) {
    const nightStart = cursor + cfg.nightRestBandStartHour * 3600000;
    const nightEnd = cursor + (24 + cfg.nightRestBandEndHour) * 3600000;
    nightMinutes += overlapMinutes(wallStart, wallEnd, nightStart, nightEnd);
    const dow = new Date(cursor).getUTCDay();
    if (dow === 0 || dow === 6) {
      weekendMinutes += overlapMinutes(
        wallStart,
        wallEnd,
        cursor,
        cursor + dayMs,
      );
    }
  }
  return { nightMinutes, weekendMinutes };
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

  // Ohne Ankunft ODER Abfahrt nicht berechenbar -> Prueffall. Ein fehlendes
  // Zeitfenster ist KEIN Prueffall: dann wird ab Ankunft gezaehlt (Nutzer 2026-08-01).
  if (arrival === null || departure === null) {
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

  // Kein Zeitfenster (weder Transporeon/Sixfold noch Excel) -> ab Ankunft zaehlen.
  const hasWindow = windowStart !== null;
  const arrivedLate = hasWindow && arrival > windowStart;
  const lateGraceEnabled = Boolean(cfg.lateArrivalGraceEnabled);
  const lateGraceMinutes = Math.max(
    0,
    Number.isFinite(Number(cfg.lateArrivalGraceMinutes))
      ? Number(cfg.lateArrivalGraceMinutes)
      : DEFAULT_CONFIG.lateArrivalGraceMinutes,
  );

  // Regel 2: Zaehlbeginn ab Fenster, bei Spaetankunft ab Ankunft.
  // Wartezeit vor dem Fenster wird nie gezaehlt.
  // Mit aktivierter Verspaetungsregel gilt fuer alle Spaetankuenfte 3h frei.
  // Die 3h-Regel greift aber ERST, wenn die Ankunft mehr als lateGraceMinutes
  // (Standard 45 min) NACH dem Zeitfenster liegt (Nutzer 2026-08-04). Kommt man
  // z.B. bei Fenster 07:00 um 07:30 (30 min zu spaet), greift sie noch nicht;
  // erst ab 07:46 (46 min zu spaet).
  const lateGraceApplies =
    lateGraceEnabled &&
    hasWindow &&
    arrival > windowStart + lateGraceMinutes * 60000;

  const freeMinutesForCharge = lateGraceApplies ? 180 : cfg.freeMinutes;
  effectiveFreeMinutes = freeMinutesForCharge;
  const countStartMs = lateGraceApplies
    ? arrival
    : hasWindow
      ? Math.max(windowStart, arrival)
      : arrival;
  const countStart = new Date(countStartMs).toISOString();

  let countedMinutes = Math.round((departure - countStartMs) / 60000);
  if (countedMinutes < 0) countedMinutes = 0;

  // Regel 7b: Ruhezeit automatisch abziehen (gesetzliche 9h Ruhe bei Langfahrten).
  // Wenn Standzeit > 10h, wird 9h (540 min) als Ruhezeit abgezogen (Nutzer 2026-08-04).
  // Nutzer-Vorgabe 2026-07-20: keine Multi-Visit-Probleme erwartet, daher
  // automatisch abziehen statt zu pruefen.
  const REST_TIME_THRESHOLD_MIN = 10 * 60; // 10 Stunden
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
      rebooking_suspected: false,
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

  // Regel 8: Nacht-/Wochenendruhe im gezaehlten Zeitraum -> Prueffall statt
  // automatischer Abrechnung. Der (potenzielle) Betrag bleibt zur
  // Nachvollziehbarkeit sichtbar, wird aber ueber needs_review aus der
  // Gesamtsumme herausgehalten.
  let needsReview = Boolean(input.needs_review);
  let finalReason = reason;
  let restReviewApplied = false;
  let restNightMinutes = 0;
  let restWeekendMinutes = 0;
  if (chargeable && cfg.restReviewEnabled) {
    const ov = restReviewOverlap(countStartMs, departure, cfg);
    restNightMinutes = Math.round(ov.nightMinutes);
    restWeekendMinutes = Math.round(ov.weekendMinutes);
    const nightHit = ov.nightMinutes >= cfg.nightRestReviewMinutes;
    const weekendHit = ov.weekendMinutes >= cfg.weekendReviewMinutes;
    if (nightHit || weekendHit) {
      needsReview = true;
      restReviewApplied = true;
      finalReason = REASON.REST_PERIOD_INCLUDED;
    }
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
    reason: finalReason,
    // Prueffall, wenn Zeitbasis unbelegbar (aus Stopp) ODER eine Nacht-/
    // Wochenendruhe im Zeitraum liegt (Regel 8).
    needs_review: needsReview,
    rest_review_applied: restReviewApplied,
    rest_review_night_minutes: restNightMinutes,
    rest_review_weekend_minutes: restWeekendMinutes,
    rebooking_suspected: false,
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
