"use strict";

/**
 * Reine Abgleich-Logik fuer den Transporeon-Zuschlags-Export (Bauplan §14-§20).
 *
 * KEIN Dateizugriff, KEIN Express - nur Funktionen auf einfachen Objekten,
 * damit der geldkritische Abgleich vollstaendig testbar ist.
 *
 * Grundsatz (wie im ganzen Cockpit): Niemals raten. Eindeutig -> verarbeiten;
 * mehrdeutig/unklar -> PRUEFEN. Bestehende Werte werden nie blind ueberschrieben,
 * nichts wird geloescht.
 */

const model = require("./subsidyModel");
const { STATUS, QUELLE } = model;

// Deutsche Spaltenueberschriften des Transporeon-Exports (Blatt "Zuschlaege").
const COLUMNS = Object.freeze({
  transportnr: "Transportnr.",
  zuschlagsId: "Zuschlags-ID",
  art: "Name",
  preis: "Preis",
  waehrung: "Zuschlag - Währung",
  beschreibung: "Beschreibung",
  status: "Status",
  begruendung: "Begründung",
  systemzeit: "Systemzeitstempel",
});

/**
 * Excel-Status auf den internen Status abbilden. Nur EINDEUTIGE Begriffe -
 * alles andere -> null (Aufrufer behandelt es als Fehlerzeile, §17).
 * @param {unknown} value
 * @returns {"AKZEPTIERT"|"ABGELEHNT"|null}
 */
function mapExcelStatus(value) {
  const t = String(value ?? "")
    .trim()
    .toLowerCase();
  if (t === "akzeptiert" || t === "accepted" || t === "genehmigt") {
    return STATUS.AKZEPTIERT;
  }
  if (t === "abgelehnt" || t === "rejected" || t === "declined") {
    return STATUS.ABGELEHNT;
  }
  return null;
}

/**
 * Eine Export-Zeile in einen Abgleich-Kandidaten umwandeln.
 * @param {object} row  Zeile als Objekt (Spaltenname -> Wert)
 * @returns {{ok: true, candidate: object} | {ok: false, errors: string[], raw: object}}
 */
function parseRow(row = {}) {
  const zuschlagsId = String(row[COLUMNS.zuschlagsId] ?? "").trim();
  const transportnr = String(row[COLUMNS.transportnr] ?? "").trim();
  const cola = model.normalizeCola(transportnr);
  const art = model.normalizeArt(row[COLUMNS.art]);
  const betrag = model.parseAmount(row[COLUMNS.preis]);
  const status = mapExcelStatus(row[COLUMNS.status]);
  const waehrung = String(row[COLUMNS.waehrung] ?? "")
    .trim()
    .toUpperCase();
  const entscheidungsdatum = model.normalizeDate(row[COLUMNS.systemzeit]);

  const errors = [];
  if (!zuschlagsId) errors.push("Zuschlags-ID fehlt");
  if (!cola) errors.push("Transportnr./Cola-Nr. fehlt");
  if (betrag === null) errors.push("Preis fehlt oder ist keine Zahl");
  if (!status) errors.push(`Status unbekannt: "${row[COLUMNS.status] ?? ""}"`);
  if (waehrung && waehrung !== "EUR") {
    errors.push(`Waehrung ist nicht EUR: ${waehrung}`);
  }
  if (errors.length) return { ok: false, errors, raw: row };

  return {
    ok: true,
    candidate: {
      zuschlags_id: zuschlagsId,
      cola_nummer: cola,
      cola_nummer_original: transportnr,
      zuschlagsart: art, // kann null sein (Art ist nur sekundaerer Schluessel)
      betrag,
      waehrung: waehrung || "EUR",
      status,
      entscheidungsdatum,
      beschreibung: String(row[COLUMNS.beschreibung] ?? "").trim(),
      begruendung: String(row[COLUMNS.begruendung] ?? "").trim(),
    },
  };
}

/**
 * Alle Export-Zeilen parsen. Trennt gueltige Kandidaten von Fehlerzeilen.
 * @param {object[]} rows
 * @returns {{candidates: object[], errors: {index: number, errors: string[], raw: object}[]}}
 */
function parseRows(rows = []) {
  const candidates = [];
  const errors = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const result = parseRow(row);
    if (result.ok) candidates.push(result.candidate);
    else errors.push({ index, errors: result.errors, raw: result.raw });
  });
  return { candidates, errors };
}

/**
 * Sucht den passenden Cockpit-Datensatz zu einem Kandidaten.
 * 1. ueber gespeicherte Zuschlags-ID (starker, eindeutiger Schluessel).
 * 2. sonst ueber Cola-Nr. + Art + Betrag bei noch NICHT verknuepften Saetzen.
 * Mehrere Treffer -> ambiguous (spaeter PRUEFEN). Archivierte werden ignoriert.
 * @param {object} candidate
 * @param {object[]} records
 * @returns {{record: object|null, matchedBy: string|null, ambiguous: boolean, candidates: object[]}}
 */
function matchCandidate(candidate, records = []) {
  const list = (Array.isArray(records) ? records : []).filter(
    (r) => !r.archiviert,
  );

  const byId = list.filter(
    (r) =>
      r.zuschlags_id &&
      String(r.zuschlags_id) === String(candidate.zuschlags_id),
  );
  if (byId.length === 1) {
    return { record: byId[0], matchedBy: "zuschlags_id", ambiguous: false, candidates: byId };
  }
  if (byId.length > 1) {
    return { record: null, matchedBy: "zuschlags_id", ambiguous: true, candidates: byId };
  }

  const byKey = list.filter(
    (r) =>
      !r.zuschlags_id &&
      r.cola_nummer === candidate.cola_nummer &&
      (candidate.zuschlagsart ? r.zuschlagsart === candidate.zuschlagsart : true) &&
      Number(r.beantragte_summe) === Number(candidate.betrag),
  );
  if (byKey.length === 1) {
    return { record: byKey[0], matchedBy: "cola_art_betrag", ambiguous: false, candidates: byKey };
  }
  if (byKey.length > 1) {
    return { record: null, matchedBy: "cola_art_betrag", ambiguous: true, candidates: byKey };
  }

  return { record: null, matchedBy: null, ambiguous: false, candidates: [] };
}

/**
 * Entscheidet, was fuer EINEN Kandidaten zu tun ist (rein, ohne Schreiben).
 * @param {object} candidate
 * @param {object[]} records
 * @param {{now?: string}} [ctx]
 * @returns {{action: "no_match"|"pruefen"|"noop"|"update", reason: string, recordId?: string, matchedBy?: string, changes?: object, candidate: object}}
 */
function planReconcile(candidate, records = [], ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const m = matchCandidate(candidate, records);

  if (m.ambiguous) {
    return {
      action: "pruefen",
      reason: `mehrdeutiger Treffer (${m.matchedBy}, ${m.candidates.length} Saetze)`,
      matchCount: m.candidates.length,
      candidate,
    };
  }
  if (!m.record) {
    return { action: "no_match", reason: "kein Datensatz im Cockpit", candidate };
  }

  const rec = m.record;
  const targetStatus = candidate.status;
  const genehmigt = targetStatus === STATUS.AKZEPTIERT ? candidate.betrag : 0;

  const already =
    rec.status === targetStatus &&
    String(rec.zuschlags_id || "") === String(candidate.zuschlags_id) &&
    Number(rec.genehmigte_summe) === Number(genehmigt) &&
    String(rec.entscheidungsdatum || "") ===
      String(candidate.entscheidungsdatum || "");
  if (already) {
    return { action: "noop", reason: "bereits abgeglichen", recordId: rec.id, candidate };
  }

  const changes = {
    status: targetStatus,
    zuschlags_id: candidate.zuschlags_id,
    genehmigte_summe: genehmigt,
    entscheidungsdatum: candidate.entscheidungsdatum,
    status_quelle: QUELLE.TRANSPOREON_EXCEL,
    letzter_transporeon_abgleich: now,
  };

  return {
    action: "update",
    reason: `${m.matchedBy} -> ${targetStatus}`,
    recordId: rec.id,
    matchedBy: m.matchedBy,
    changes,
    candidate,
  };
}

/**
 * Plant den Abgleich fuer ALLE Kandidaten SEQUENZIELL, damit ein Datensatz nicht
 * von zwei Kandidaten getroffen wird (nach einem Treffer gilt er als verknuepft).
 * Schreibt NICHTS - liefert nur die Plaene.
 * @param {object[]} candidates
 * @param {object[]} records
 * @param {{now?: string}} [ctx]
 * @returns {object[]} Plaene (gleiche Reihenfolge wie candidates)
 */
function planReconcileAll(candidates = [], records = [], ctx = {}) {
  const working = (Array.isArray(records) ? records : []).map((r) => ({ ...r }));
  const plans = [];
  for (const candidate of candidates) {
    const plan = planReconcile(candidate, working, ctx);
    plans.push(plan);
    if (plan.action === "update") {
      const idx = working.findIndex((r) => r.id === plan.recordId);
      if (idx >= 0) working[idx] = { ...working[idx], ...plan.changes };
    }
  }
  return plans;
}

/**
 * Zaehlt die Plaene zu einer Kurzuebersicht zusammen.
 * @param {object[]} plans
 * @returns {{update: number, noop: number, pruefen: number, no_match: number, total: number}}
 */
function summarizePlans(plans = []) {
  const summary = { update: 0, noop: 0, pruefen: 0, no_match: 0, total: 0 };
  for (const p of Array.isArray(plans) ? plans : []) {
    summary.total += 1;
    if (p.action in summary) summary[p.action] += 1;
  }
  return summary;
}

module.exports = {
  COLUMNS,
  mapExcelStatus,
  parseRow,
  parseRows,
  matchCandidate,
  planReconcile,
  planReconcileAll,
  summarizePlans,
};
