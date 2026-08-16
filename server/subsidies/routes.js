"use strict";

/**
 * HTTP-Endpunkte fuer das Zuschlags-Cockpit (Bauplan §10, §12, §26-§30, §37).
 *
 * Eingebunden in server/index.js via:
 *   app.use("/api/subsidies", require("./subsidies/routes"));
 *
 * Nutzt den globalen express.json()-Parser aus index.js.
 */

const express = require("express");

const { SubsidyStore } = require("./subsidyStore");
const model = require("./subsidyModel");
const subsidyImport = require("./subsidyImport");
const XLSX = require("xlsx");

const store = new SubsidyStore();
const router = express.Router();

function actorFrom(req) {
  const header = req.get("x-user") || req.get("x-actor");
  return (header && String(header).trim()) || "web";
}

// Liste mit Filtern (Monat/Status/Art/Ansicht/Suche). Suche liefert ALLE
// Treffer einer Cola-Nr (§37).
router.get("/", (req, res) => {
  try {
    const records = store.list({
      month: req.query.month,
      status: req.query.status,
      art: req.query.art,
      view: req.query.view,
      search: req.query.search,
      includeArchived: req.query.includeArchived === "1",
    });
    res.json({
      ok: true,
      count: records.length,
      records: records.map((r) => ({ ...r, ansicht: model.deriveView(r) })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Kennzahlen fuer das Dashboard (§30).
router.get("/stats", (req, res) => {
  try {
    res.json({ ok: true, stats: store.stats({ month: req.query.month }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Neuen Zuschlag anlegen. Deckt manuelle Anlage (§12) UND "Standgeld
// uebernehmen" (§10) ab - Unterscheidung nur ueber das Feld "quelle".
router.post("/", (req, res) => {
  try {
    const input = req.body || {};
    const check = model.validateInput(input);
    if (!check.ok) {
      return res.status(400).json({ ok: false, errors: check.errors });
    }
    const record = store.create(input, {
      actor: actorFrom(req),
      source: input.quelle || model.QUELLE.MANUELL,
    });
    res.status(201).json({ ok: true, record });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Transporeon-Export (.xlsx) hochladen und abgleichen (Bauplan §14-§20).
// Rohbytes der Datei im Body. Mit ?dryRun=1 wird NUR geplant, nichts geschrieben
// - so kann der Nutzer den Abgleich gefahrlos ansehen, bevor er ihn ausfuehrt.
router.post(
  "/import",
  express.raw({ type: () => true, limit: "25mb" }),
  (req, res) => {
    try {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Keine Datei empfangen (leerer Body)." });
      }

      let workbook;
      try {
        workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Datei ist keine lesbare Excel-Datei (.xlsx).",
        });
      }

      // Bevorzugt das Blatt "Zuschläge", sonst das erste Blatt.
      const sheetName =
        workbook.SheetNames.find((n) => /zuschl/i.test(n)) ||
        workbook.SheetNames[0];
      const sheet = sheetName ? workbook.Sheets[sheetName] : null;
      if (!sheet) {
        return res
          .status(400)
          .json({ ok: false, error: "Kein Tabellenblatt gefunden." });
      }

      const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" });
      const { candidates, errors } = subsidyImport.parseRows(rows);

      const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
      const result = store.reconcile(candidates, {
        actor: actorFrom(req),
        dryRun,
      });

      // Details fuer die Anzeige: was muss der Nutzer selbst pruefen?
      const pruefen = result.plans
        .filter((p) => p.action === "pruefen")
        .map((p) => ({
          zuschlags_id: p.candidate.zuschlags_id,
          cola_nummer: p.candidate.cola_nummer,
          betrag: p.candidate.betrag,
          reason: p.reason,
        }));
      const noMatch = result.plans
        .filter((p) => p.action === "no_match")
        .map((p) => ({
          zuschlags_id: p.candidate.zuschlags_id,
          cola_nummer: p.candidate.cola_nummer,
          zuschlagsart: p.candidate.zuschlagsart,
          betrag: p.candidate.betrag,
          status: p.candidate.status,
        }));

      res.json({
        ok: true,
        dryRun: result.dryRun,
        sheet: sheetName,
        rows: rows.length,
        parseErrors: errors,
        summary: { ...result.summary, parseFehler: errors.length },
        applied: result.applied,
        pruefen,
        noMatch,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  },
);

// Einzelnen Zuschlag inkl. Historie lesen.
router.get("/:id", (req, res) => {
  try {
    const record = store.get(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({
      ok: true,
      record: { ...record, ansicht: model.deriveView(record) },
      history: store.history(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Status/Betrag/Zuschlags-ID etc. aendern.
router.patch("/:id", (req, res) => {
  try {
    const changes = { ...(req.body || {}) };
    // Wird eine Entscheidung getroffen und kein Datum mitgegeben, heute setzen.
    const decisive =
      changes.status === model.STATUS.AKZEPTIERT ||
      changes.status === model.STATUS.ABGELEHNT;
    if (decisive && !changes.entscheidungsdatum) {
      changes.entscheidungsdatum = new Date().toISOString().slice(0, 10);
    }
    const record = store.update(req.params.id, changes, {
      actor: actorFrom(req),
      source: req.body?.source || "manuell",
    });
    if (!record) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({
      ok: true,
      record: { ...record, ansicht: model.deriveView(record) },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// In TransLogica erfasst markieren (§26).
router.post("/:id/tl-erfasst", (req, res) => {
  try {
    const record = store.markTlErfasst(req.params.id, {
      actor: actorFrom(req),
      source: "tl",
    });
    if (!record) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({
      ok: true,
      record: { ...record, ansicht: model.deriveView(record) },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Archivieren (§28) - loescht nie.
router.post("/:id/archive", (req, res) => {
  try {
    const record = store.archive(req.params.id, {
      actor: actorFrom(req),
      source: "manuell",
    });
    if (!record) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({
      ok: true,
      record: { ...record, ansicht: model.deriveView(record) },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

module.exports = router;
