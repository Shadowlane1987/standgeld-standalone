"use strict";

/**
 * Reine Fachlogik fuer das Zuschlags-Cockpit (Bauplan §5-§9, §11, §29, §44).
 *
 * KEINE Dateizugriffe, KEIN Express - damit die Regeln ohne I/O testbar sind.
 * Grundsatz: Niemals raten. Eindeutig -> verarbeiten; unklar -> PRUEFEN.
 */

// Entscheidungs-Status eines Zuschlags. "In TL erfasst" und "Archiviert" sind
// KEINE Status, sondern eigene Flags (tl_erfasst / archiviert), siehe §26/§28.
const STATUS = Object.freeze({
  UNBEKANNT: "UNBEKANNT",
  OFFEN: "OFFEN",
  AKZEPTIERT: "AKZEPTIERT",
  ABGELEHNT: "ABGELEHNT",
  PRUEFEN: "PRUEFEN",
});

const ALLOWED_STATUS = new Set(Object.values(STATUS));

// Zuschlagsarten (§12). Liste bewusst erweiterbar.
const ZUSCHLAGSART = Object.freeze({
  STANDGELD: "STANDGELD",
  RETOURE: "RETOURE",
  AUSFALLFRACHT: "AUSFALLFRACHT",
  ZWEITE_ANLIEFERUNG: "ZWEITE_ANLIEFERUNG",
  AFF: "AFF",
  SONSTIGES: "SONSTIGES",
});

const ALLOWED_ART = new Set(Object.values(ZUSCHLAGSART));

const ART_SYNONYMS = new Map([
  ["standgeld", ZUSCHLAGSART.STANDGELD],
  ["standzeit", ZUSCHLAGSART.STANDGELD],
  ["retoure", ZUSCHLAGSART.RETOURE],
  ["retour", ZUSCHLAGSART.RETOURE],
  ["retouren", ZUSCHLAGSART.RETOURE],
  ["ausfallfracht", ZUSCHLAGSART.AUSFALLFRACHT],
  ["ausfall", ZUSCHLAGSART.AUSFALLFRACHT],
  ["zweite anlieferung", ZUSCHLAGSART.ZWEITE_ANLIEFERUNG],
  ["2. anlieferung", ZUSCHLAGSART.ZWEITE_ANLIEFERUNG],
  ["zweite_anlieferung", ZUSCHLAGSART.ZWEITE_ANLIEFERUNG],
  ["zweiter anlieferungsversuch", ZUSCHLAGSART.ZWEITE_ANLIEFERUNG],
  ["aff", ZUSCHLAGSART.AFF],
  ["preisbeanstandung", ZUSCHLAGSART.SONSTIGES],
  ["sondertransport", ZUSCHLAGSART.SONSTIGES],
  ["sonstiges", ZUSCHLAGSART.SONSTIGES],
  ["sonstige", ZUSCHLAGSART.SONSTIGES],
]);

const QUELLE = Object.freeze({
  MANUELL: "manuell",
  STANDGELD_APP: "standgeld_app",
  TRANSPOREON_EXCEL: "transporeon_excel",
  TRANSPOREON_EMAIL: "transporeon_email",
});

// Verkehrsart - MUSS getrennt gefuehrt werden (Nah- vs. Fernverkehr).
const VERKEHR = Object.freeze({
  NAHVERKEHR: "NAHVERKEHR",
  FERNVERKEHR: "FERNVERKEHR",
});

const ALLOWED_VERKEHR = new Set(Object.values(VERKEHR));

const VERKEHR_SYNONYMS = new Map([
  ["nahverkehr", VERKEHR.NAHVERKEHR],
  ["nah", VERKEHR.NAHVERKEHR],
  ["nv", VERKEHR.NAHVERKEHR],
  ["fernverkehr", VERKEHR.FERNVERKEHR],
  ["fern", VERKEHR.FERNVERKEHR],
  ["fv", VERKEHR.FERNVERKEHR],
]);

const SCHEMA_VERSION = 1;

/**
 * Cola-Nummer auf die LETZTEN SIEBEN ZIFFERN normalisieren (§6).
 * "M1_20260805_0006676210" -> "6676210". Weniger als 7 Ziffern -> alle Ziffern.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCola(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length <= 7 ? digits : digits.slice(-7);
}

/**
 * Betrag robust nach Zahl (EUR) parsen. Akzeptiert "120", "120,50", "1.234,56",
 * "120.50", Zahl. Ungueltig/leer -> null.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/[€\s]/g, "");
  // Deutsches Format: Punkt = Tausender, Komma = Dezimal.
  if (text.includes(",")) {
    text = text.replace(/\./g, "").replace(",", ".");
  }
  const num = Number(text);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

/**
 * Zuschlagsart normalisieren. Unbekannt -> null (Aufrufer entscheidet:
 * manuell = Fehler, Import = Prueffall §19).
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeArt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (ALLOWED_ART.has(upper)) return upper;
  const mapped = ART_SYNONYMS.get(raw.toLowerCase());
  return mapped || null;
}

function normalizeStatus(value) {
  const upper = String(value ?? "")
    .trim()
    .toUpperCase();
  return ALLOWED_STATUS.has(upper) ? upper : null;
}

/**
 * Verkehrsart normalisieren. Unbekannt/leer -> null.
 * @param {unknown} value
 * @returns {"NAHVERKEHR"|"FERNVERKEHR"|null}
 */
function normalizeVerkehr(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (ALLOWED_VERKEHR.has(upper)) return upper;
  return VERKEHR_SYNONYMS.get(raw.toLowerCase()) || null;
}

/**
 * Datum auf "YYYY-MM-DD" bringen. Akzeptiert ISO, "YYYY-MM-DD", "DD.MM.YYYY",
 * Date. Ungueltig -> null.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const de = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) {
    const dd = de[1].padStart(2, "0");
    const mm = de[2].padStart(2, "0");
    return `${de[3]}-${mm}-${dd}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

/**
 * Monatsschluessel "YYYY-MM" aus dem Antragsdatum (§29). Fallback: created_at.
 * @param {object} record
 * @returns {string|null}
 */
function deriveMonthKey(record) {
  const base =
    normalizeDate(record?.antragsdatum) ||
    normalizeDate(record?.entscheidungsdatum) ||
    normalizeDate(record?.created_at);
  return base ? base.slice(0, 7) : null;
}

/**
 * Abgeleitete Ansicht (§4). archiviert schlaegt alles; sonst nach Status/TL.
 * @param {object} record
 * @returns {"archiv"|"pruefen"|"abgelehnt"|"akzeptiert_tl_offen"|"abgeschlossen"|"offen"}
 */
function deriveView(record) {
  if (record?.archiviert) return "archiv";
  if (record?.pruefung_erforderlich || record?.status === STATUS.PRUEFEN) {
    return "pruefen";
  }
  if (record?.status === STATUS.ABGELEHNT) return "abgelehnt";
  if (record?.status === STATUS.AKZEPTIERT) {
    return record?.tl_erfasst ? "abgeschlossen" : "akzeptiert_tl_offen";
  }
  return "offen";
}

/**
 * Validiert eine MANUELLE Neuanlage (§12) bzw. Standgeld-Uebernahme (§10).
 * @param {object} input
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateInput(input = {}) {
  const errors = [];
  if (!normalizeCola(input.cola_nummer)) {
    errors.push("Cola-Nr. fehlt oder enthaelt keine Ziffern.");
  }
  if (!normalizeArt(input.zuschlagsart)) {
    errors.push("Zuschlagsart fehlt oder ist unbekannt.");
  }
  if (parseAmount(input.beantragte_summe) === null) {
    errors.push("Beantragte Summe fehlt oder ist keine Zahl.");
  }
  if (!normalizeDate(input.antragsdatum ?? input.datum)) {
    errors.push("Datum fehlt oder ist ungueltig.");
  }
  if (!normalizeVerkehr(input.verkehr)) {
    errors.push("Verkehrsart fehlt (Nahverkehr oder Fernverkehr waehlen).");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Baut einen vollstaendigen Zuschlags-Datensatz. Startstatus IMMER UNBEKANNT
 * (§11), sofern nicht explizit gesetzt. ID/Zeitstempel liefert der Aufrufer.
 * @param {object} input
 * @param {{id: string, now?: string}} ctx
 * @returns {object}
 */
function createRecord(input = {}, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const original = String(
    input.cola_nummer_original ?? input.cola_nummer ?? "",
  ).trim();
  const details = input.standgeld_details;

  return {
    id: ctx.id,
    cola_nummer: normalizeCola(input.cola_nummer),
    cola_nummer_original: original || null,
    zuschlags_id: input.zuschlags_id ? String(input.zuschlags_id).trim() : null,
    zuschlagsart: normalizeArt(input.zuschlagsart) || ZUSCHLAGSART.SONSTIGES,
    verkehr: normalizeVerkehr(input.verkehr),
    grund: String(input.grund ?? "").trim(),
    bemerkung: String(input.bemerkung ?? "").trim(),
    beantragte_summe: parseAmount(input.beantragte_summe),
    genehmigte_summe: parseAmount(input.genehmigte_summe),
    status: normalizeStatus(input.status) || STATUS.UNBEKANNT,
    antragsdatum:
      normalizeDate(input.antragsdatum ?? input.datum) || now.slice(0, 10),
    entscheidungsdatum: normalizeDate(input.entscheidungsdatum),
    tl_erfasst: Boolean(input.tl_erfasst),
    tl_erfasst_am: input.tl_erfasst ? input.tl_erfasst_am || now : null,
    archiviert: Boolean(input.archiviert),
    archiviert_am: input.archiviert ? input.archiviert_am || now : null,
    lade_oder_entladestelle:
      String(input.lade_oder_entladestelle ?? "").trim() || null,
    quelle: input.quelle || QUELLE.MANUELL,
    status_quelle: input.status_quelle || null,
    email_message_id: input.email_message_id || null,
    email_empfangen_am: input.email_empfangen_am || null,
    transporeon_import_id: input.transporeon_import_id || null,
    letzter_transporeon_abgleich: input.letzter_transporeon_abgleich || null,
    pruefung_erforderlich: Boolean(input.pruefung_erforderlich),
    pruefgrund: input.pruefgrund ? String(input.pruefgrund).trim() : null,
    standgeld_details:
      details && typeof details === "object" ? { ...details } : null,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };
}

// Felder, deren Aenderung fuer die Audit-Historie relevant ist (§32).
const AUDIT_FIELDS = [
  "status",
  "zuschlags_id",
  "genehmigte_summe",
  "beantragte_summe",
  "zuschlagsart",
  "tl_erfasst",
  "archiviert",
  "pruefung_erforderlich",
  "pruefgrund",
  "entscheidungsdatum",
  "verkehr",
];

/**
 * Wendet Aenderungen auf einen Datensatz an (rein) und liefert die neuen
 * Audit-Eintraege fuer geaenderte Felder. Setzt updated_at.
 * @param {object} record
 * @param {object} changes
 * @param {{actor?: string, source?: string, now?: string}} ctx
 * @returns {{record: object, audit: object[]}}
 */
function applyChanges(record, changes = {}, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const next = { ...record };
  const audit = [];

  for (const [key, rawValue] of Object.entries(changes)) {
    if (key === "id" || key === "created_at") continue;
    let value = rawValue;
    if (key === "status") value = normalizeStatus(rawValue) || record.status;
    else if (key === "zuschlagsart") {
      value = normalizeArt(rawValue) || record.zuschlagsart;
    } else if (key === "verkehr") {
      value = normalizeVerkehr(rawValue);
    } else if (key === "beantragte_summe" || key === "genehmigte_summe") {
      value = parseAmount(rawValue);
    } else if (key === "entscheidungsdatum" || key === "antragsdatum") {
      value = normalizeDate(rawValue);
    }
    next[key] = value;
  }

  for (const field of AUDIT_FIELDS) {
    if (String(next[field]) !== String(record[field])) {
      audit.push({
        ts: now,
        actor: ctx.actor || "system",
        source: ctx.source || null,
        field,
        from: record[field] ?? null,
        to: next[field] ?? null,
      });
    }
  }

  next.updated_at = now;
  return { record: next, audit };
}

/**
 * Markiert einen Zuschlag als in TransLogica erfasst (§26).
 */
function markTlErfasst(record, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  return applyChanges(
    record,
    { tl_erfasst: true, tl_erfasst_am: now },
    { ...ctx, now },
  );
}

/**
 * Archiviert einen Zuschlag (§28) - LOESCHT NIE.
 */
function archive(record, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  return applyChanges(
    record,
    { archiviert: true, archiviert_am: now },
    { ...ctx, now },
  );
}

/**
 * Kennzahlen fuer einen Monat (oder alle) berechnen (§30, §45).
 * @param {object[]} records
 * @param {{month?: string|null}} [options]
 * @returns {object}
 */
function summarize(records, options = {}) {
  const month = options.month || null;
  const list = (Array.isArray(records) ? records : []).filter((r) => {
    if (!month || month === "alle") return true;
    return deriveMonthKey(r) === month;
  });

  const stats = {
    month: month || "alle",
    anzahl: list.length,
    beantragt_summe: 0,
    akzeptiert_summe: 0,
    offen_summe: 0,
    abgelehnt_summe: 0,
    akzeptiert_tl_offen_summe: 0,
    counts: {
      offen: 0,
      akzeptiert_tl_offen: 0,
      abgeschlossen: 0,
      abgelehnt: 0,
      pruefen: 0,
      archiv: 0,
    },
    art_counts: {},
  };

  for (const r of list) {
    const beantragt = Number(r.beantragte_summe || 0);
    const genehmigt = Number(
      r.genehmigte_summe != null ? r.genehmigte_summe : r.beantragte_summe || 0,
    );
    stats.beantragt_summe += beantragt;

    const view = deriveView(r);
    if (view in stats.counts) stats.counts[view] += 1;

    if (r.status === STATUS.AKZEPTIERT) {
      stats.akzeptiert_summe += genehmigt;
      if (!r.tl_erfasst) stats.akzeptiert_tl_offen_summe += genehmigt;
    } else if (r.status === STATUS.ABGELEHNT) {
      stats.abgelehnt_summe += beantragt;
    } else if (r.status === STATUS.UNBEKANNT || r.status === STATUS.OFFEN) {
      stats.offen_summe += beantragt;
    }

    const art = r.zuschlagsart || ZUSCHLAGSART.SONSTIGES;
    stats.art_counts[art] = (stats.art_counts[art] || 0) + 1;
  }

  // Runden auf 2 Nachkommastellen.
  for (const key of Object.keys(stats)) {
    if (key.endsWith("_summe")) {
      stats[key] = Math.round(stats[key] * 100) / 100;
    }
  }

  return stats;
}

module.exports = {
  STATUS,
  ALLOWED_STATUS,
  ZUSCHLAGSART,
  ALLOWED_ART,
  QUELLE,
  VERKEHR,
  ALLOWED_VERKEHR,
  SCHEMA_VERSION,
  normalizeCola,
  parseAmount,
  normalizeArt,
  normalizeStatus,
  normalizeVerkehr,
  normalizeDate,
  deriveMonthKey,
  deriveView,
  validateInput,
  createRecord,
  applyChanges,
  markTlErfasst,
  archive,
  summarize,
};
