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
