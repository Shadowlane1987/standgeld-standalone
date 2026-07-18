"use strict";

/**
 * Ende-zu-Ende-Orchestrator Standgeld (reine Komposition, kein I/O).
 *
 * Bindet die gesamte Kette in einem Aufruf zusammen:
 *   (Grid-HTML ->) normalisierte Events
 *     -> crossCheckEvents (TP-XP vs. GPS-belegte Visibility)
 *     -> buildStops (Lade-/Entladestopps mit massgeblichen Zeiten)
 *     -> runBilling (Fensterwahl Transporeon/Excel + Datumsbereich + Gebuehr).
 *
 * Erfindet nichts: jede Stufe bleibt nachvollziehbar und einzeln testbar.
 */

const { parseEventGrid } = require("./eventGrid");
const { crossCheckEvents } = require("./crossCheck");
const { buildStops } = require("./standing");
const { runBilling } = require("./billing");

/**
 * Rechnet aus bereits normalisierten Events das Standgeld.
 *
 * @param {Array<object>} events - normalizeEventRow/parseEventGrid-Ausgabe
 * @param {object} [options]
 * @param {number} [options.toleranceMinutes]
 * @param {Map<string,object>} [options.excelIndex]
 * @param {Map<string,string>|object} [options.transporeonWindows]
 * @param {{from?:string|Date|null,to?:string|Date|null,year?:number}} [options.range]
 * @param {object} [options.config]
 * @returns {Readonly<object>}
 */
function computeStandgeldFromEvents(events, options = {}) {
  const cross = crossCheckEvents(events || [], {
    toleranceMinutes: options.toleranceMinutes,
  });
  const stops = buildStops(cross.phases);
  const billing = runBilling({
    stops,
    excelIndex: options.excelIndex,
    transporeonWindows: options.transporeonWindows,
    range: options.range,
    config: options.config,
  });

  return Object.freeze({
    event_count: (events || []).length,
    phases: cross.phases,
    cross_summary: cross.summary,
    review_count: cross.review_count,
    stops,
    range: billing.range,
    items: billing.items,
    selected: billing.selected,
    summary: billing.summary,
  });
}

/**
 * Rechnet direkt aus dem Event-Grid-HTML (page.content()) das Standgeld.
 *
 * @param {string} html
 * @param {object} [options] siehe computeStandgeldFromEvents (+ importRunId/importedAt)
 * @returns {Readonly<object>}
 */
function computeStandgeldFromGrid(html, options = {}) {
  const events = parseEventGrid(html, {
    importRunId: options.importRunId,
    importedAt: options.importedAt,
  });
  return computeStandgeldFromEvents(events, options);
}

module.exports = {
  computeStandgeldFromEvents,
  computeStandgeldFromGrid,
};
