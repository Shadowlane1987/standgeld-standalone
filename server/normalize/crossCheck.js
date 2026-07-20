"use strict";

/**
 * Gegenpruefung TP-XP (Ladestelle) vs. VisibilityHubUser (GPS) je Phase (§14).
 *
 * Fachlogik (Abrechnungsmodell):
 * - Nur GPS-verifizierte VisibilityHubUser-Zeiten gelten als belastbarer
 *   Gegenbeweis. VisibilityHubUser ohne echte Koordinaten (0/0) ist NICHT
 *   belegbar -> als Prueffall markieren, nicht als Beweis verwenden.
 * - Weicht die belegte VisibilityHubUser-Zeit von der TP-XP-Zeit ab, ist das ein
 *   PRUEFFALL (needs_review), keine blinde Abrechnung.
 * - Es wird nichts berechnet, was nicht belegt ist; nichts wird erfunden.
 *
 * Reine, unit-testbare Funktionen (kein I/O).
 */

const { SOURCE_TYPE, EVENT_CATEGORY } = require("./events");

/**
 * Phasen, die fuer die Standgeld-Gegenpruefung relevant sind
 * (Ankunft/Abfahrt an Belade- und Entladestelle).
 */
const RELEVANT_PHASES = Object.freeze([
  EVENT_CATEGORY.LOAD_ARRIVAL,
  EVENT_CATEGORY.LOAD_DEPARTURE,
  EVENT_CATEGORY.UNLOAD_ARRIVAL,
  EVENT_CATEGORY.UNLOAD_DEPARTURE,
]);

/**
 * Ergebnis-Status einer einzelnen Phase.
 */
const CROSSCHECK_STATUS = Object.freeze({
  MATCH: "MATCH", // TP-XP und belegte Visibility stimmen (innerhalb Toleranz)
  DISCREPANCY: "DISCREPANCY", // belegte Visibility weicht von TP-XP ab -> Prueffall
  TP_XP_ONLY: "TP_XP_ONLY", // nur Ladestellen-Zeit, kein Visibility-Event
  VISIBILITY_ONLY: "VISIBILITY_ONLY", // nur belegte GPS-Zeit, kein TP-XP
  NOT_PROVABLE: "NOT_PROVABLE", // Visibility vorhanden, aber ohne echtes GPS
  EMPTY: "EMPTY", // keine verwertbare Zeit
});

function toEpoch(isoString) {
  if (!isoString) return null;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? null : ms;
}

function diffMinutes(isoA, isoB) {
  const a = toEpoch(isoA);
  const b = toEpoch(isoB);
  if (a === null || b === null) return null;
  return Math.round(Math.abs(a - b) / 60000);
}

function groupKey(event) {
  // Fachregel: pro Transport genau eine Belade- und eine Entladephase. Die
  // Lieferungsnummer wird NICHT zum Gruppieren genutzt, weil sie je Quelle
  // fehlen kann (TP-XP oft null, VisibilityHubUser gesetzt) und sonst die
  // zusammengehoerenden Zeiten auseinanderreissen wuerde.
  return [event.transport_number ?? "", event.event_category ?? ""].join("||");
}

/**
 * Ankunftsphasen (Belade-/Entlade-Ankunft). Bei Mehrfachbesuchen (§Regel 3)
 * zaehlt die ERSTE Ankunft, bei Abfahrten die LETZTE endgueltige Abfahrt.
 */
function isArrivalPhase(category) {
  return (
    category === EVENT_CATEGORY.LOAD_ARRIVAL ||
    category === EVENT_CATEGORY.UNLOAD_ARRIVAL
  );
}

/**
 * Zaehlt die unterschiedlichen Aufenthalte einer Quelle (auf Minutenraster).
 * Mehrere gleiche Zeitstempel gelten als EIN Besuch (Rausch-/Doppel-Events).
 *
 * @param {Array<object>} events
 * @returns {number}
 */
function distinctVisitCount(events) {
  const minutes = new Set();
  for (const e of events) {
    const t = toEpoch(e.event_time);
    if (t !== null) minutes.add(Math.round(t / 60000));
  }
  return minutes.size;
}

/**
 * Waehlt aus mehreren Events derselben Quelle das massgebliche aus.
 * Fachregel Mehrfachbesuch (§Regel 3): bei Ankunft die FRUEHESTE Zeit, bei
 * Abfahrt die SPAETESTE (endgueltige) Zeit. Fehlt die Zeit, entscheidet der
 * order_index.
 *
 * preferOrigin: liegt ein Event dieser Herkunft vor (z.B. "EXPORT" = saubere,
 * gepaarte Transporeon-Ist-Zeit), wird NUR aus diesen gewaehlt. Das verhindert,
 * dass eine widerspruechliche Wire-Zeit die Spanne kuenstlich aufblaeht.
 *
 * @param {Array<object>} events
 * @param {"earliest"|"latest"} mode
 * @param {string|null} [preferOrigin]
 * @returns {{ chosen: object|null, count: number }}
 */
function pickPrimary(events, mode, preferOrigin = null) {
  if (!events.length) return { chosen: null, count: 0 };
  let pool = events;
  if (preferOrigin) {
    const preferred = events.filter((e) => e.origin === preferOrigin);
    if (preferred.length) pool = preferred;
  }
  const sorted = [...pool].sort((a, b) => {
    const at = toEpoch(a.event_time);
    const bt = toEpoch(b.event_time);
    if (at === null && bt === null) {
      const ai = a.order_index ?? Number.MAX_SAFE_INTEGER;
      const bi = b.order_index ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    }
    if (at === null) return 1;
    if (bt === null) return -1;
    return at - bt;
  });
  const chosen = mode === "latest" ? sorted[sorted.length - 1] : sorted[0];
  return { chosen, count: events.length };
}

/**
 * Bildet fuer eine Phase (eine Gruppe) das Gegenpruef-Ergebnis.
 *
 * @param {object[]} groupEvents
 * @param {number} toleranceMinutes
 * @returns {object} eingefrorenes Ergebnisobjekt
 */
function evaluateGroup(groupEvents, toleranceMinutes) {
  const first = groupEvents[0];

  // Lieferungsnummer aus der Quelle uebernehmen, die sie gesetzt hat.
  const deliveryNumber =
    groupEvents.map((e) => e.delivery_number).find((d) => d != null) ?? null;

  const tpEvents = groupEvents.filter(
    (e) => e.source_type === SOURCE_TYPE.TP_XP,
  );
  const visEvents = groupEvents.filter(
    (e) => e.source_type === SOURCE_TYPE.VISIBILITY,
  );

  // Ankunft -> frueheste Zeit, Abfahrt -> spaeteste Zeit (Mehrfachbesuch §3).
  const mode = isArrivalPhase(first.event_category) ? "earliest" : "latest";

  // TP-XP: die saubere Export-Ist-Zeit bevorzugen (gepaart, verlaesslich),
  // damit widerspruechliche Wire-Zeiten die Spanne nicht aufblaehen.
  const { chosen: tp, count: tpCount } = pickPrimary(tpEvents, mode, "EXPORT");
  const { chosen: vis, count: visCount } = pickPrimary(visEvents, mode);

  // Mehrfachbesuch (§Regel 3) zeigt sich in den GPS-Events (Sixfold:
  // Ankunft/Abfahrt/Ankunft/Abfahrt). Nur echte Wiederholbesuche zaehlen; die
  // erste Ankunft/letzte Abfahrt sind bereits gewaehlt. Wegen abzuziehender
  // Ruhezeiten ist das immer ein Prueffall.
  const multiVisit = distinctVisitCount(visEvents) > 1;

  const visProvable = Boolean(vis && vis.gps_verified);
  const diff = tp && vis ? diffMinutes(tp.event_time, vis.event_time) : null;

  let status;
  let authoritativeTime = null;
  let authoritativeSource = null;
  let authoritativeEvent = null;
  let needsReview = false;
  let note = null;

  if (tp && visProvable) {
    if (diff !== null && diff <= toleranceMinutes) {
      status = CROSSCHECK_STATUS.MATCH;
    } else {
      status = CROSSCHECK_STATUS.DISCREPANCY;
      needsReview = true;
      note = `TP-XP und belegte Visibility weichen um ${diff} min ab.`;
    }
    // GPS-belegte Zeit ist der massgebliche Beweis.
    authoritativeTime = vis.event_time;
    authoritativeSource = SOURCE_TYPE.VISIBILITY;
    authoritativeEvent = vis;
  } else if (tp && vis && !visProvable) {
    // Visibility vorhanden, aber ohne echtes GPS -> nicht belegbar (§10/Filter).
    status = CROSSCHECK_STATUS.NOT_PROVABLE;
    needsReview = true;
    authoritativeTime = tp.event_time;
    authoritativeSource = SOURCE_TYPE.TP_XP;
    authoritativeEvent = tp;
    note =
      "VisibilityHubUser-Zeit ohne echtes GPS (nicht belegbar) - nur TP-XP-Zeit vorhanden.";
  } else if (tp && !vis) {
    status = CROSSCHECK_STATUS.TP_XP_ONLY;
    authoritativeTime = tp.event_time;
    authoritativeSource = SOURCE_TYPE.TP_XP;
    authoritativeEvent = tp;
  } else if (!tp && visProvable) {
    status = CROSSCHECK_STATUS.VISIBILITY_ONLY;
    authoritativeTime = vis.event_time;
    authoritativeSource = SOURCE_TYPE.VISIBILITY;
    authoritativeEvent = vis;
  } else if (!tp && vis && !visProvable) {
    status = CROSSCHECK_STATUS.NOT_PROVABLE;
    needsReview = true;
    note = "Nur nicht-belegbare VisibilityHubUser-Zeit (0/0) vorhanden.";
  } else {
    status = CROSSCHECK_STATUS.EMPTY;
  }

  // Mehrfachbesuch immer als Prueffall: erste Ankunft/letzte Abfahrt stehen,
  // aber gesetzliche Ruhezeiten muessen manuell abgezogen werden.
  if (multiVisit) {
    needsReview = true;
    const hint =
      "Mehrfachbesuch erkannt (mehrere An-/Abfahrten) - erste Ankunft bis letzte Abfahrt, Ruhezeiten manuell pruefen.";
    note = note ? `${note} ${hint}` : hint;
  }

  return Object.freeze({
    transport_number: first.transport_number ?? null,
    delivery_number: deliveryNumber,
    phase: first.event_category ?? null,

    tp_xp_time: tp ? tp.event_time : null,
    tp_xp_local: tp ? (tp.event_time_local ?? null) : null,
    tp_xp_count: tpCount,

    visibility_time: vis ? vis.event_time : null,
    visibility_local: vis ? (vis.event_time_local ?? null) : null,
    visibility_gps_verified: visProvable,
    visibility_count: visCount,

    diff_minutes: diff,
    status,
    multi_visit: multiVisit,
    authoritative_time: authoritativeTime,
    authoritative_source: authoritativeSource,
    authoritative_local: authoritativeEvent
      ? (authoritativeEvent.event_time_local ?? null)
      : null,
    timezone: authoritativeEvent ? (authoritativeEvent.timezone ?? null) : null,
    needs_review: needsReview,
    note,
  });
}

/**
 * Fuehrt die Gegenpruefung ueber eine Liste normalisierter Rohevents durch.
 *
 * @param {Array<object>} events - Ausgabe von normalizeEventRow/parseEventGrid
 * @param {{ toleranceMinutes?: number }} [options]
 * @returns {{ phases: object[], summary: Record<string, number>, review_count: number }}
 */
function crossCheckEvents(events, options = {}) {
  const toleranceMinutes = Number.isFinite(options.toleranceMinutes)
    ? options.toleranceMinutes
    : 0;

  const relevant = (events || []).filter((e) =>
    RELEVANT_PHASES.includes(e.event_category),
  );

  const groups = new Map();
  for (const event of relevant) {
    const key = groupKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  const phases = [];
  for (const groupEvents of groups.values()) {
    phases.push(evaluateGroup(groupEvents, toleranceMinutes));
  }

  const summary = {};
  let reviewCount = 0;
  for (const phase of phases) {
    summary[phase.status] = (summary[phase.status] || 0) + 1;
    if (phase.needs_review) reviewCount += 1;
  }

  return { phases, summary, review_count: reviewCount };
}

module.exports = {
  RELEVANT_PHASES,
  CROSSCHECK_STATUS,
  diffMinutes,
  pickPrimary,
  evaluateGroup,
  crossCheckEvents,
};
