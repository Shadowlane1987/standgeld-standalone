"use strict";

/**
 * Parser fuer das Transporeon "Event Management" / Sichtbarkeits-Grid (§7, §8).
 *
 * Quelle: gerendertes GXT/Ext-GWT-Grid im Transport-Assignment-View
 * (AssignedTransportsCarrier). Jede Ereigniszeile ist ein <tr class="gxGridRow">
 * mit semantisch benannten Zellen (class="... gxColumn-<name> ...").
 *
 * Diese Datei enthaelt AUSSCHLIESSLICH reine Funktionen und ist damit ohne
 * Browser vollstaendig unit-testbar. Der Playwright-Teil liefert lediglich das
 * HTML (page.content()) und ruft parseEventGrid(html) auf.
 *
 * Wichtig (Fachlogik):
 * - Es wird NICHTS berechnet und KEINE Quelle bevorzugt. Nur normalisiert.
 * - Die Kategorisierung/Quelle/GPS-Bewertung uebernimmt normalizeEventRow().
 * - Koordinaten "0 0" => nicht verifiziert (§10), bleibt aber erhalten.
 */

const { normalizeEventRow } = require("./events");

/**
 * Abbildung der deutschsprachigen Grid-Labels auf die technischen
 * Transporeon-Status-Qualifier (status.*). Verifiziert gegen die GWT-RPC
 * String-Tabelle von LoadTransportVisibilityAction.
 *
 * WICHTIG: "unloading" enthaelt "loading" als Substring -- die nachgelagerte
 * categorizeStatusQualifier() prueft Entlade-Faelle zuerst, daher unkritisch.
 */
const STATUS_LABEL_TO_QUALIFIER = Object.freeze({
  "ortung beginn": "status.locating.begin",
  "ortung ende": "status.locating.end",
  "fährt richtung beladestelle": "status.headingtowards.loadingstation",
  "fährt richtung entladestelle": "status.headingtowards.unloadingstation",
  "beladen ankunft": "status.loading.arrival",
  "beladen beginn": "status.loading.begin",
  "beladen ende": "status.loading.end",
  "beladen abfahrt": "status.loading.departure",
  "entladen ankunft": "status.unloading.arrival",
  "entladen beginn": "status.unloading.begin",
  "entladen ende": "status.unloading.end",
  "entladen abfahrt": "status.unloading.departure",
});

/**
 * Entfernt HTML-Tags/Entities und normalisiert Whitespace zu Reintext.
 *
 * @param {string} htmlFragment
 * @returns {string}
 */
function stripTags(htmlFragment) {
  return String(htmlFragment || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrahiert die Transportnummer aus der Grid-Kopfzeile, falls vorhanden.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractTransportNumber(html) {
  const m = /Transportnr\.?:\s*([A-Za-z0-9_./-]+)/i.exec(String(html || ""));
  return m ? m[1].trim() : null;
}

/**
 * Liest alle Grid-Zeilen (gxGridRow) als rohe Zell-Map aus.
 *
 * @param {string} html
 * @returns {Array<Record<string, string>>} rohe Zeilen (Schluessel = gxColumn-Name)
 */
function parseGridRows(html) {
  const source = String(html || "");
  const rows = [];
  const rowRe = /<tr[^>]*gxGridRow[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRe.exec(source))) {
    const chunk = rowMatch[1];
    const cells = {};
    const cellRe = /gxColumn-([A-Za-z0-9]+)"[^>]*>([\s\S]*?)<\/td>/g;
    let cellMatch;

    while ((cellMatch = cellRe.exec(chunk))) {
      const name = cellMatch[1];
      const rawCell = cellMatch[2];
      cells[name] = stripTags(rawCell);

      // Scheduler-/Disponenten-ID aus dem onclick der Quelle mitnehmen.
      if (name === "schedulerCreatedId") {
        const idMatch =
          /ta_showSchedulerDetailsWithSU\((\d+)/.exec(rawCell) ||
          /\((\d+)\s*,/.exec(rawCell);
        cells.schedulerId = idMatch ? idMatch[1] : null;
      }
    }

    if (Object.keys(cells).length > 0) rows.push(cells);
  }

  return rows;
}

/**
 * Wandelt eine rohe Grid-Zeile in das lose Eingabeformat fuer normalizeEventRow.
 *
 * @param {Record<string, string>} cells
 * @param {{ transportNumber?: string|null }} [ctx]
 * @returns {Record<string, unknown>}
 */
function gridRowToEventInput(cells, ctx = {}) {
  const label = cells.qualifier || null;
  const normalizedLabel = String(label || "")
    .trim()
    .toLowerCase();
  const qualifier = STATUS_LABEL_TO_QUALIFIER[normalizedLabel] || null;

  const coords = cells.identity && cells.identity !== "-" ? cells.identity : "";

  return {
    transport_number: ctx.transportNumber ?? null,
    delivery_number:
      cells.objectSubId && cells.objectSubId !== "-" ? cells.objectSubId : null,
    event_name: label,
    status_qualifier: qualifier,
    event_time: cells.declaredDatetime || null,
    timestamp: cells.datetimeCreated || null,
    timezone:
      cells.declaredDatetimeTimezone && cells.declaredDatetimeTimezone !== "-"
        ? cells.declaredDatetimeTimezone
        : null,
    source: cells.schedulerCreatedId || null,
    scheduler_id: cells.schedulerId ?? null,
    company: cells.companyCreatedId || null,
    comment: cells.comment && cells.comment !== "-" ? cells.comment : null,
    coordinates: coords,
    severity: cells.severity || null,
  };
}

/**
 * Hauptfunktion: parst das Event-Grid-HTML zu normalisierten Rohevents.
 *
 * @param {string} html - page.content() des Grid-Frames
 * @param {{ importRunId?: string, importedAt?: string }} [ctx]
 * @returns {Array<object>} normalisierte, unveraenderliche Rohevents
 */
function parseEventGrid(html, ctx = {}) {
  const transportNumber = extractTransportNumber(html);
  const rows = parseGridRows(html);

  return rows.map((cells, index) => {
    const input = gridRowToEventInput(cells, { transportNumber });
    const normalized = normalizeEventRow(input, {
      importRunId: ctx.importRunId,
      importedAt: ctx.importedAt,
      orderIndex: index,
    });
    return normalized;
  });
}

module.exports = {
  STATUS_LABEL_TO_QUALIFIER,
  stripTags,
  extractTransportNumber,
  parseGridRows,
  gridRowToEventInput,
  parseEventGrid,
};
