"use strict";

/**
 * Datei-basierter Store fuer Zuschlaege (Bauplan §3, §31, §32).
 *
 * Bewusst OHNE Datenbank/native Abhaengigkeit - passt zum Rest der App und
 * laeuft auf Render (persistente Disk) wie unter Windows.
 *
 * Ablage (Standard: <APP_DATA_DIR>/subsidies):
 *   subsidies/records/<id>.json  -- ein Datensatz pro Datei
 *   subsidies/audit/<id>.jsonl   -- Aenderungshistorie, append-only
 *
 * Grundsaetze:
 * - NIEMALS loeschen (§3/§31). Statt dessen archivieren.
 * - Jede Aenderung schreibt Audit-Eintraege (§32).
 * - Atomare Schreibvorgaenge (tmp-Datei + rename), damit nie halbe Dateien
 *   entstehen.
 */

const fs = require("fs");
const path = require("path");

const model = require("./subsidyModel");
const subsidyImport = require("./subsidyImport");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

/**
 * Sortierbare, kollisionsarme ID: "20260815-184455-a1b2c3".
 */
function generateId(now = new Date()) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}-${rand}`;
}

function defaultRoot() {
  const base = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(process.cwd(), "data");
  return path.join(base, "subsidies");
}

class SubsidyStore {
  /**
   * @param {{ root?: string }} [options]
   */
  constructor(options = {}) {
    this.root = options.root || defaultRoot();
    this.recordsDir = path.join(this.root, "records");
    this.auditDir = path.join(this.root, "audit");
  }

  _init() {
    ensureDir(this.recordsDir);
    ensureDir(this.auditDir);
  }

  _recordFile(id) {
    return path.join(this.recordsDir, `${id}.json`);
  }

  _auditFile(id) {
    return path.join(this.auditDir, `${id}.jsonl`);
  }

  _writeAtomic(file, content) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  }

  _appendAudit(id, entries) {
    if (!entries || !entries.length) return;
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(this._auditFile(id), lines);
  }

  /**
   * Legt einen neuen Zuschlag an. Startstatus IMMER UNBEKANNT (§11).
   * @param {object} input
   * @param {{actor?: string, source?: string}} [ctx]
   * @returns {object} gespeicherter Datensatz
   */
  create(input, ctx = {}) {
    this._init();
    const now = new Date();
    let id = generateId(now);
    // Kollision extrem unwahrscheinlich, trotzdem absichern.
    while (fs.existsSync(this._recordFile(id))) {
      id = generateId(new Date());
    }
    const record = model.createRecord(input, { id, now: now.toISOString() });
    this._writeAtomic(this._recordFile(id), JSON.stringify(record, null, 2));
    this._appendAudit(id, [
      {
        ts: record.created_at,
        actor: ctx.actor || "system",
        source: ctx.source || record.quelle,
        field: "created",
        from: null,
        to: record.status,
      },
    ]);
    return record;
  }

  /**
   * Liest einen Datensatz. Nicht vorhanden -> null.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    try {
      const raw = fs.readFileSync(this._recordFile(id), "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Liest die Audit-Historie eines Datensatzes (aelteste zuerst).
   * @param {string} id
   * @returns {object[]}
   */
  history(id) {
    try {
      const raw = fs.readFileSync(this._auditFile(id), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Alle Datensaetze laden und optional filtern.
   * @param {{month?: string, status?: string, art?: string, view?: string, search?: string, includeArchived?: boolean}} [filter]
   * @returns {object[]}
   */
  list(filter = {}) {
    this._init();
    let files;
    try {
      files = fs.readdirSync(this.recordsDir);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }

    let records = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(this.recordsDir, f), "utf8"),
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const searchCola = filter.search ? model.normalizeCola(filter.search) : "";
    const searchRaw = String(filter.search ?? "")
      .trim()
      .toLowerCase();

    records = records.filter((r) => {
      if (filter.month && filter.month !== "alle") {
        if (model.deriveMonthKey(r) !== filter.month) return false;
      }
      if (filter.art && filter.art !== "alle") {
        if (r.zuschlagsart !== model.normalizeArt(filter.art)) return false;
      }
      if (filter.status && filter.status !== "alle") {
        if (r.status !== model.normalizeStatus(filter.status)) return false;
      }
      if (filter.view && filter.view !== "alle") {
        if (model.deriveView(r) !== filter.view) return false;
      } else if (!filter.includeArchived && filter.view !== "archiv") {
        // Ohne explizite Archiv-Ansicht archivierte Eintraege ausblenden.
        if (r.archiviert) return false;
      }
      if (searchRaw) {
        // Suche per Cola-Nr liefert ALLE Treffer (§37) - kein Dedup.
        const hitCola = searchCola && r.cola_nummer === searchCola;
        const hitOriginal = String(r.cola_nummer_original ?? "")
          .toLowerCase()
          .includes(searchRaw);
        const hitZuschlagsId = String(r.zuschlags_id ?? "")
          .toLowerCase()
          .includes(searchRaw);
        if (!hitCola && !hitOriginal && !hitZuschlagsId) return false;
      }
      return true;
    });

    // Neueste zuerst.
    records.sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
    return records;
  }

  /**
   * Aendert einen Datensatz und schreibt Audit-Eintraege. Nicht vorhanden ->
   * null.
   * @param {string} id
   * @param {object} changes
   * @param {{actor?: string, source?: string}} [ctx]
   * @returns {object|null}
   */
  update(id, changes, ctx = {}) {
    const current = this.get(id);
    if (!current) return null;
    const { record, audit } = model.applyChanges(current, changes, ctx);
    this._writeAtomic(this._recordFile(id), JSON.stringify(record, null, 2));
    this._appendAudit(id, audit);
    return record;
  }

  /**
   * Markiert als in TransLogica erfasst (§26).
   */
  markTlErfasst(id, ctx = {}) {
    const current = this.get(id);
    if (!current) return null;
    const { record, audit } = model.markTlErfasst(current, ctx);
    this._writeAtomic(this._recordFile(id), JSON.stringify(record, null, 2));
    this._appendAudit(id, audit);
    return record;
  }

  /**
   * Archiviert (§28) - loescht nie.
   */
  archive(id, ctx = {}) {
    const current = this.get(id);
    if (!current) return null;
    const { record, audit } = model.archive(current, ctx);
    this._writeAtomic(this._recordFile(id), JSON.stringify(record, null, 2));
    this._appendAudit(id, audit);
    return record;
  }

  /**
   * Kennzahlen fuer das Dashboard (§30).
   */
  stats(filter = {}) {
    const records = this.list({
      ...filter,
      includeArchived: true,
      view: "alle",
    });
    return model.summarize(records, { month: filter.month });
  }

  /**
   * Gleicht Kandidaten aus dem Transporeon-Export gegen die Cockpit-Datensaetze
   * ab (Bauplan §14-§20). Geldkritisch: Es wird NUR bei eindeutigem Treffer
   * automatisch aktualisiert; mehrdeutig/ohne Treffer -> nur gemeldet, nichts
   * geraten, nichts geloescht.
   *
   * @param {object[]} candidates  geparste Kandidaten (aus subsidyImport.parseRows)
   * @param {{actor?: string, dryRun?: boolean, importId?: string, now?: string}} [ctx]
   * @returns {{dryRun: boolean, importId: string, summary: object, applied: string[], plans: object[]}}
   */
  reconcile(candidates = [], ctx = {}) {
    this._init();
    const dryRun = !!ctx.dryRun;
    const now = ctx.now || new Date().toISOString();
    const importId = ctx.importId || generateId(new Date());

    const records = this.list({ includeArchived: true, view: "alle" });
    const plans = subsidyImport.planReconcileAll(candidates, records, { now });
    const summary = subsidyImport.summarizePlans(plans);

    const applied = [];
    if (!dryRun) {
      for (const plan of plans) {
        if (plan.action !== "update") continue;
        const changes = { ...plan.changes, transporeon_import_id: importId };
        const record = this.update(plan.recordId, changes, {
          actor: ctx.actor || "transporeon-import",
          source: model.QUELLE.TRANSPOREON_EXCEL,
        });
        if (record) applied.push(record.id);
      }
    }

    return { dryRun, importId, summary, applied, plans };
  }
}

module.exports = { SubsidyStore, generateId };
