"use strict";

/**
 * Unveraenderliche Rohdatenhaltung fuer Standgeld (§7).
 *
 * Grundsatz:
 * - Rohdaten und berechnete Ergebnisse werden GETRENNT gespeichert.
 * - Rohdaten sind append-only / write-once. Eine neue Berechnungsregel darf die
 *   urspruenglichen Rohdaten niemals veraendern.
 * - Keine externe/native Abhaengigkeit: einfache JSONL-Dateien, damit die App
 *   auch auf Render (free) und unter Windows problemlos laeuft.
 *
 * Ablagestruktur (Standard: <projekt>/data, per .gitignore ausgeschlossen):
 *   data/runs/<runId>.meta.json      -- Metadaten des Importlaufs
 *   data/responses/<runId>.raw.txt   -- urspruenglicher Roh-Response (write-once)
 *   data/events/<runId>.jsonl        -- normalisierte Rohevents (append-only)
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = path.join(__dirname, "..", "..", "data");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

/**
 * Erzeugt eine sortierbare, kollisionsarme Importlauf-ID.
 * @returns {string} z.B. "20260717-184455-a1b2c3"
 */
function generateRunId(now = new Date()) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}-${rand}`;
}

class RawStore {
  /**
   * @param {{ root?: string }} [options]
   */
  constructor(options = {}) {
    this.root = options.root || DEFAULT_ROOT;
    this.runsDir = path.join(this.root, "runs");
    this.responsesDir = path.join(this.root, "responses");
    this.eventsDir = path.join(this.root, "events");
  }

  _init() {
    ensureDir(this.runsDir);
    ensureDir(this.responsesDir);
    ensureDir(this.eventsDir);
  }

  /**
   * Legt einen neuen Importlauf an (§7: Importlauf + Importdatum).
   * @param {Record<string, unknown>} [meta]
   * @returns {{ runId: string, importedAt: string, meta: object }}
   */
  createImportRun(meta = {}) {
    this._init();
    const importedAt = new Date().toISOString();
    const runId = generateRunId();
    const record = {
      run_id: runId,
      imported_at: importedAt,
      source: meta.source || null,
      transport_number: meta.transport_number || null,
      transport_id: meta.transport_id || null,
      note: meta.note || null,
      extra: meta.extra || null,
    };
    const file = path.join(this.runsDir, `${runId}.meta.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: "wx" });
    return { runId, importedAt, meta: record };
  }

  /**
   * Speichert den urspruenglichen Roh-Response write-once (§7: Rohwert).
   * @param {string} runId
   * @param {string} rawText
   * @returns {string} Pfad der geschriebenen Datei
   */
  saveRawResponse(runId, rawText) {
    this._init();
    const file = path.join(this.responsesDir, `${runId}.raw.txt`);
    // "wx": schlaegt fehl, wenn die Datei existiert -> Rohdaten bleiben immutable.
    fs.writeFileSync(file, String(rawText ?? ""), { flag: "wx" });
    return file;
  }

  /**
   * Haengt normalisierte Rohevents an (append-only, §7).
   * @param {string} runId
   * @param {object[]} events
   * @returns {number} Anzahl geschriebener Events
   */
  appendRawEvents(runId, events) {
    this._init();
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return 0;
    const file = path.join(this.eventsDir, `${runId}.jsonl`);
    const payload =
      list.map((event) => JSON.stringify(event)).join("\n") + "\n";
    fs.appendFileSync(file, payload);
    return list.length;
  }

  /**
   * Liest die normalisierten Rohevents eines Laufs.
   * @param {string} runId
   * @returns {object[]}
   */
  readRawEvents(runId) {
    const file = path.join(this.eventsDir, `${runId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /**
   * Liefert alle Importlaeufe (neueste zuerst).
   * @returns {object[]}
   */
  listRuns() {
    if (!fs.existsSync(this.runsDir)) return [];
    return fs
      .readdirSync(this.runsDir)
      .filter((name) => name.endsWith(".meta.json"))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(this.runsDir, name), "utf8")),
      )
      .sort((a, b) => String(b.run_id).localeCompare(String(a.run_id)));
  }
}

module.exports = {
  DEFAULT_ROOT,
  RawStore,
  generateRunId,
};
