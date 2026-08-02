"use strict";

const path = require("node:path");
const { chromium } = require("playwright");

const { normalizeTransportNumber } = require("../normalize/exportBilling");

const PROFILE_DIR = process.env.PW_SURCHARGE_PROFILE_DIR
  ? path.resolve(process.env.PW_SURCHARGE_PROFILE_DIR)
  : path.join(process.cwd(), ".pw-profile-surcharge");
const START_URL =
  "https://login.transporeon.com/?locale=de&return=AssignedTransportsCarrier";
const NUMBER_CELL_SELECTORS = [
  'td[class*="gxColumn-number"] div.taMJE',
  'td[class*="gxColumn-number"] div',
  'td[class*="gxColumn-number"] span',
  'td[class*="gxColumn-number"]',
];

let activeContext = null;
let activeContextLaunch = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isContextUsable(context) {
  if (!context) return false;
  try {
    const browser = context.browser();
    if (
      browser &&
      typeof browser.isConnected === "function" &&
      !browser.isConnected()
    ) {
      return false;
    }
    const pages = context.pages();
    // Ein geschlossener persistenter Kontext hat keine Seiten mehr.
    if (
      Array.isArray(pages) &&
      pages.length === 0 &&
      (!browser || !browser.isConnected())
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function closeActiveContext() {
  if (!activeContext) return;
  try {
    await activeContext.close();
  } catch {
    // ignore close errors
  }
  activeContext = null;
}

async function getOrCreateContext(options = {}) {
  if (await isContextUsable(activeContext)) return activeContext;

  // Toter/geschlossener Kontext -> verwerfen, damit ein frischer gestartet wird.
  activeContext = null;

  if (activeContextLaunch) return activeContextLaunch;

  activeContextLaunch = chromium
    .launchPersistentContext(options.profileDir || PROFILE_DIR, {
      headless: Boolean(options.headless),
      viewport: { width: 1680, height: 980 },
      locale: "de-DE",
    })
    .then((context) => {
      // Kein Standard-Timeout -> einzelne Aktionen wuerden bis 30s blockieren
      // ("haengt"). Kurzes Limit: lieber schnell scheitern als endlos warten.
      try {
        context.setDefaultTimeout(8000);
      } catch {
        // ignore
      }
      activeContext = context;
      return context;
    })
    .finally(() => {
      activeContextLaunch = null;
    });

  return activeContextLaunch;
}

function normalizeTransportLoose(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalizeTransportNumber(raw) || raw;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findListFrame(context) {
  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      try {
        const has = await frame.evaluate(() => {
          const hasNumberGrid = !!document.querySelector(
            'td[class*="gxColumn-number"]',
          );
          const hasSearchField = !!document.querySelector(
            'input[type="text"], input[placeholder*="Such" i], input[aria-label*="Such" i]',
          );
          return hasNumberGrid || hasSearchField;
        });
        if (has) return { page: pg, frame };
      } catch {
        // ignore cross-origin/inaccessible frames
      }
    }
  }
  return null;
}

async function waitForListFrame(context, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : 90000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = await findListFrame(context);
    if (found) return found;
    await sleep(pollMs);
  }

  return null;
}

async function scrollListToLoadAllRows(frame) {
  try {
    await frame.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const grid = Array.from(document.querySelectorAll("div"))
        .filter((node) => node.scrollHeight > node.clientHeight + 40)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!grid) return;
      let lastTop = -1;
      for (let i = 0; i < 60; i += 1) {
        grid.scrollTop = grid.scrollHeight;
        await wait(300);
        if (grid.scrollTop === lastTop) break;
        lastTop = grid.scrollTop;
      }
      grid.scrollTop = 0;
    });
  } catch {
    // best effort
  }
}

async function collectTransportRows(frame) {
  const rows = await frame.evaluate(() => {
    const selectors = [
      'td[class*="gxColumn-number"] div.taMJE',
      'td[class*="gxColumn-number"] div',
      'td[class*="gxColumn-number"] span',
      'td[class*="gxColumn-number"]',
    ];
    const normalizeDigits = (text) => {
      const match = String(text || "")
        .trim()
        .match(/(\d{10})$/);
      return match ? match[1] : String(text || "").trim();
    };

    const seen = new Set();
    const out = [];
    let index = 0;

    for (const selector of selectors) {
      const cells = Array.from(document.querySelectorAll(selector));
      for (const cell of cells) {
        const text = String(cell.textContent || "").trim();
        if (!text) continue;
        if (!/(\d{10}|\d{7,})/.test(text)) continue;
        const dedupeKey = text;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const norm = normalizeDigits(text);
        const last7 = norm.replace(/\D/g, "").slice(-7);
        out.push({ index, text, norm, last7 });
        index += 1;
      }
    }

    return out;
  });

  return Array.isArray(rows) ? rows : [];
}

function buildTransportCellLocator(frame, rowText) {
  const text = String(rowText || "").trim();
  const exact = new RegExp(`^${escapeRegExp(text)}$`);
  const prefix = new RegExp(`^${escapeRegExp(text)}`);

  return [
    frame.locator(NUMBER_CELL_SELECTORS[0], { hasText: exact }).first(),
    frame.locator(NUMBER_CELL_SELECTORS[1], { hasText: exact }).first(),
    frame.locator(NUMBER_CELL_SELECTORS[2], { hasText: exact }).first(),
    frame.locator(NUMBER_CELL_SELECTORS[3], { hasText: exact }).first(),
    frame.locator(NUMBER_CELL_SELECTORS[1], { hasText: prefix }).first(),
    frame.locator(NUMBER_CELL_SELECTORS[3], { hasText: prefix }).first(),
  ];
}

async function clickTransportCell(frame, rowText) {
  const locators = buildTransportCellLocator(frame, rowText);
  for (const locator of locators) {
    try {
      if ((await locator.count()) < 1) continue;
      if (!(await locator.isVisible())) continue;
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await locator.click({ timeout: 5000, force: true });
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

function resolveRowMatch(rows, transportNumber) {
  const tn = String(transportNumber || "").trim();
  if (!tn) return null;
  const norm = normalizeTransportLoose(tn);
  const last7 = norm.replace(/\D/g, "").slice(-7);

  const exact = rows.find((row) => String(row.text || "").trim() === tn);
  if (exact) return exact;

  const normMatch = rows.find((row) => String(row.norm || "").trim() === norm);
  if (normMatch) return normMatch;

  if (last7.length >= 7) {
    const last7Match = rows.find((row) => String(row.last7 || "") === last7);
    if (last7Match) return last7Match;
  }

  return null;
}

function transportSearchQueries(transportNumber) {
  const raw = String(transportNumber || "").trim();
  const normalized = normalizeTransportLoose(raw);
  const normalizedDigits = normalized.replace(/\D/g, "");
  const last10 = normalizedDigits.slice(-10);
  const last7 = normalizedDigits.slice(-7);
  const unique = new Set([raw, normalized, last10, last7].filter(Boolean));
  return Array.from(unique);
}

async function inputSearchQuery(context, query) {
  const selectors = [
    'input[placeholder*="Such" i]',
    'input[aria-label*="Such" i]',
    'input[id*="search" i]',
    'input[class*="search" i]',
    'input[type="text"]',
  ];

  for (const selector of selectors) {
    const fields = context.locator(selector);
    const count = await fields.count();
    for (let i = 0; i < count; i += 1) {
      const field = fields.nth(i);
      try {
        if (!(await field.isVisible())) continue;
        if (!(await field.isEnabled())) continue;
        await field.click({ timeout: 1500, force: true });
        await field.fill("");
        await field.fill(query);
        await field.press("Enter").catch(() => {});
        return true;
      } catch {
        // try next search field
      }
    }
  }

  return false;
}

async function clearSearchField(context) {
  const selectors = [
    'input[placeholder*="Such" i]',
    'input[aria-label*="Such" i]',
    'input[id*="search" i]',
    'input[class*="search" i]',
  ];
  for (const selector of selectors) {
    const fields = context.locator(selector);
    const count = await fields.count();
    for (let i = 0; i < count; i += 1) {
      const field = fields.nth(i);
      try {
        if (!(await field.isVisible())) continue;
        await field.fill("");
        await field.press("Enter").catch(() => {});
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

// Sucht einen Transport ueber die Suchleiste und gibt die getroffene Grid-Zeile
// zurueck. Der Abgleich laeuft ueber den tatsaechlichen Grid-Inhalt (deterministisch),
// nicht ueber fragile Textsuche im gesamten DOM.
async function searchAndLocateRow(frame, page, transportNumber) {
  const queries = transportSearchQueries(transportNumber);
  if (!queries.length) {
    return { found: false, query: null, row: null };
  }

  // Vielleicht ist der Transport schon sichtbar (Liste bereits gefiltert).
  let row = resolveRowMatch(await collectTransportRows(frame), transportNumber);
  if (row) return { found: true, query: null, row };

  for (const query of queries) {
    const typed =
      (await inputSearchQuery(frame, query)) ||
      (await inputSearchQuery(page, query));
    if (!typed) continue;

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(400);
      row = resolveRowMatch(await collectTransportRows(frame), transportNumber);
      if (row) return { found: true, query, row };
    }
  }

  return { found: false, query: queries[0] || null, row: null };
}

async function clickFirstVisibleLocator(locators) {
  for (const locator of locators) {
    try {
      if ((await locator.count()) < 1) continue;
      const candidate = locator.first();
      if (!(await candidate.isVisible())) continue;
      await candidate.click({ timeout: 5000, force: true });
      return true;
    } catch {
      // try next locator
    }
  }
  return false;
}

function contextLocators(context) {
  return [
    context.locator('[class*="toolbarButton_add"]'),
    context.locator('[title*="hinzuf" i]'),
    context.locator('[aria-label*="hinzuf" i]'),
    context.locator('button:has-text("+")'),
    context.locator('[title*="Zuschlag" i]'),
  ];
}

async function clickTextIfVisible(contexts, matcher) {
  for (const ctx of contexts) {
    try {
      const locator = ctx.getByText(matcher).first();
      if (await locator.isVisible()) {
        await locator.click({ timeout: 5000, force: true });
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

async function clickPriceTab(contexts) {
  const candidates = [];
  for (const ctx of contexts) {
    // Preis-Reiter ist ein Icon-Tab ohne Text: stabile Klasse + qtip-Tooltip.
    candidates.push(ctx.locator("li.transportPriceItemsTab"));
    candidates.push(ctx.locator('[class*="transportPriceItemsTab"]'));
    candidates.push(ctx.locator('li[qtip="Preis"]'));
    candidates.push(ctx.locator('[qtip="Preis" i]'));
    candidates.push(ctx.locator('[title="Preis" i]'));
    candidates.push(ctx.getByText(/^Preis$/i));
  }
  return clickFirstVisibleLocator(candidates);
}

async function waitForPriceTabActive(contexts, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Reiter "Preis" aktivieren (Icon-Tab li.transportPriceItemsTab).
    await clickPriceTab(contexts).catch(() => {});
    for (const ctx of contexts) {
      try {
        const active = ctx.locator(
          "li.transportPriceItemsTab.tabStripActive, li.transportPriceItemsTab[class*='Active']",
        );
        if ((await active.count()) >= 1) return true;
      } catch {
        // continue
      }
    }
    await sleep(400);
  }
  return false;
}

async function closeOpenSurchargeDialog(contexts, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let openCtx = null;
    for (const ctx of contexts) {
      try {
        const typeField = ctx.locator('input[name="typeField"]').first();
        if (await typeField.isVisible()) {
          openCtx = ctx;
          break;
        }
      } catch {
        // continue
      }
    }
    if (!openCtx) return true;

    // Erst "Abbrechen" versuchen, sonst Escape auf dem Dialogfeld.
    const cancelled = await clickFirstVisibleLocator([
      openCtx.getByRole("button", { name: /^Abbrechen$/i }),
      openCtx.locator("button", { hasText: /^Abbrechen$/i }),
      openCtx.getByText(/^Abbrechen$/i),
    ]).catch(() => false);
    if (!cancelled) {
      await openCtx
        .locator('input[name="typeField"]')
        .first()
        .press("Escape")
        .catch(() => {});
    }
    await sleep(300);
  }
  return false;
}

async function openSurchargeDialog(contexts) {
  // Haengengebliebenen Dialog aus einem abgebrochenen Lauf zuerst schliessen.
  await closeOpenSurchargeDialog(contexts).catch(() => {});
  // Detail braucht Zeit bis die Reiterleiste da ist -> aktiv auf Preis warten.
  await waitForPriceTabActive(contexts);
  await sleep(500);

  // Aktiv auf sichtbaren '+'-Button (toolbarButton_add) warten und klicken.
  const addDeadline = Date.now() + 9000;
  let added = false;
  while (Date.now() < addDeadline && !added) {
    for (const ctx of contexts) {
      const add = ctx.locator('[class*="toolbarButton_add"]').first();
      try {
        if ((await add.count()) >= 1 && (await add.isVisible())) {
          await add.click({ timeout: 4000, force: true });
          added = true;
          break;
        }
      } catch {
        // erneut versuchen
      }
    }
    if (!added) await sleep(300);
  }

  if (!added) {
    for (const ctx of contexts) {
      const clicked = await clickFirstVisibleLocator(contextLocators(ctx));
      if (clicked) break;
    }
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const ctx of contexts) {
      try {
        // Schnelle, gezielte Erkennung statt DOM-weiter Textsuche (getByText).
        const typeField = ctx.locator('input[name="typeField"]').first();
        if (await typeField.isVisible()) {
          return ctx;
        }
      } catch {
        // continue
      }
    }
    await sleep(200);
  }

  throw new Error(
    "Dialog 'Zuschlag hinzufügen' wurde nicht gefunden (Preis-Reiter/Plus-Button prüfen).",
  );
}

async function fillPriceFields(context, amountEur) {
  const cents = Math.max(0, Math.round(Number(amountEur || 0) * 100));
  const euros = Math.floor(cents / 100);
  const centPart = String(cents % 100).padStart(2, "0");

  // Preisfelder tragen die (obfuskierte) Klasse 'taHAE' und liegen im Dialog.
  const priceInputs = [];
  const byClass = context.locator('input[class*="taHAE"]');
  const byClassCount = await byClass.count();
  for (let i = 0; i < byClassCount; i += 1) {
    const input = byClass.nth(i);
    if (await input.isVisible().catch(() => false)) priceInputs.push(input);
  }

  // Fallback: reine Ziffern-Inputs, aber Listen-/Paging-Felder ausschliessen.
  if (priceInputs.length < 1) {
    const inputs = context.locator(
      "input:not([type='hidden']):not([disabled])",
    );
    const count = await inputs.count();
    for (let i = 0; i < count; i += 1) {
      const input = inputs.nth(i);
      try {
        if (!(await input.isVisible())) continue;
        const value = String(await input.inputValue()).trim();
        const placeholder = String(
          (await input.getAttribute("placeholder")) || "",
        );
        const cls = String((await input.getAttribute("class")) || "");
        if (/Such/i.test(placeholder)) continue;
        if (/paging/i.test(cls)) continue;
        if (/Eintr/i.test(value)) continue;
        if (/^\d+$/.test(value)) priceInputs.push(input);
      } catch {
        // ignore read issues
      }
    }
  }

  if (!priceInputs.length) {
    throw new Error("Preisfeld wurde nicht erkannt.");
  }

  // GXT-Zahlenfelder uebernehmen .fill() nicht -> echt tippen + committen.
  await typeIntoField(priceInputs[0], String(euros));
  if (priceInputs[1]) {
    await typeIntoField(priceInputs[1], centPart);
  }
}

async function typeIntoField(input, value) {
  await input.click({ timeout: 4000, force: true }).catch(() => {});
  await input.press("Control+a").catch(() => {});
  await input.press("Delete").catch(() => {});
  await input.pressSequentially(String(value), { delay: 40 });
  // Commit erzwingen: Enter + synthetische input/change/blur-Events (GXT-Modell).
  await input.press("Enter").catch(() => {});
  await input
    .evaluate((el, v) => {
      el.value = v;
      for (const type of ["input", "change", "blur"]) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
      }
    }, String(value))
    .catch(() => {});
}

async function fillDescription(context, text) {
  const textareas = context.locator("textarea");
  const count = await textareas.count();
  for (let i = 0; i < count; i += 1) {
    const area = textareas.nth(i);
    try {
      if (!(await area.isVisible())) continue;
      await area.fill(String(text || "").trim());
      return;
    } catch {
      // continue
    }
  }
  throw new Error("Beschreibungsfeld wurde nicht gefunden.");
}

function stationValueMatches(value, station) {
  const current = String(value || "")
    .trim()
    .toLowerCase();
  const wanted = String(station || "")
    .trim()
    .toLowerCase();
  if (!current || !wanted) return false;
  // Belade- und Entladestelle sind eindeutig: der gewuenschte Begriff muss als
  // ganzes Wort im Feldwert vorkommen. So schlaegt "Beladestelle" niemals faelsch-
  // licherweise fuer "Entladestelle" an (und umgekehrt).
  return current.includes(wanted);
}

async function selectStation(contexts, stationLabel) {
  const station = String(stationLabel || "").trim();
  if (!station) return;

  for (const ctx of contexts) {
    const field = ctx.locator('input[name="occuredStation"]').first();
    try {
      if ((await field.count()) < 1) continue;
      if (!(await field.isVisible())) continue;
    } catch {
      continue;
    }

    // Schon korrekt? Nichts zu tun.
    if (
      stationValueMatches(await field.inputValue().catch(() => ""), station)
    ) {
      return;
    }

    // Schnellpfad (best effort): Feld leeren, Label tippen, Enter waehlt.
    // Einzeln abgesichert, damit ein Fehler NICHT den Dropdown-Fallback
    // ueberspringt.
    try {
      await field.click({ timeout: 3000, force: true });
      await sleep(200);
      await field.fill("", { timeout: 2500 }).catch(() => {});
      await sleep(80);
      await field.pressSequentially(station, { delay: 25, timeout: 3000 });
      await sleep(200);
      await field.press("Enter").catch(() => {});
      await sleep(150);
    } catch {
      // Schnellpfad fehlgeschlagen -> Dropdown-Fallback unten.
    }
    if (
      stationValueMatches(await field.inputValue().catch(() => ""), station)
    ) {
      return;
    }

    // Fallback: Dropdown oeffnen und die exakte Option anklicken.
    try {
      await field.click({ timeout: 3000, force: true });
      await sleep(300);
      // Erste SICHTBARE passende Option (versteckte cropText-Vorlagen kommen im
      // GXT-DOM zuerst -> nicht .first()/.last(), sondern sichtbar filtern).
      const options = ctx.getByText(
        new RegExp(`^\\s*${escapeRegExp(station)}\\s*$`, "i"),
      );
      const count = await options.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const opt = options.nth(i);
        if (!(await opt.isVisible().catch(() => false))) continue;
        await opt.click({ timeout: 3000, force: true }).catch(() => {});
        await sleep(200);
        if (
          stationValueMatches(await field.inputValue().catch(() => ""), station)
        ) {
          return;
        }
      }
    } catch {
      // naechsten Kontext versuchen
    }
    if (
      stationValueMatches(await field.inputValue().catch(() => ""), station)
    ) {
      return;
    }
    // Nicht verifiziert -> naechsten Kontext versuchen (kein stilles OK).
  }

  throw new Error(
    `Ladestelle/Entladestelle konnte nicht zuverlaessig auf '${station}' gesetzt werden. Zuschlag wurde NICHT gespeichert.`,
  );
}

async function clickSave(context) {
  const candidates = [
    context.getByRole("button", { name: /^Speichern$/i }),
    context.locator("button", { hasText: /^Speichern$/i }),
    context.getByText(/^Speichern$/i),
  ];

  const clicked = await clickFirstVisibleLocator(candidates);
  if (!clicked) {
    throw new Error("Speichern-Button wurde nicht gefunden.");
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      // Dialog gilt als geschlossen, sobald das typeField weg ist (schneller Selektor).
      const typeField = context.locator('input[name="typeField"]').first();
      if (!(await typeField.isVisible())) return;
    } catch {
      return;
    }
    await sleep(200);
  }
}

async function requestDecision(contexts) {
  // "Entscheidung einholen" (?) ist DISABLED bis die neue Zuschlag-Zeile markiert
  // ist. Nach dem Speichern rendert/selektiert das Grid verzoegert -> aktiv warten.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // Zuschlag-Zeile markieren, damit der Button aktiv wird.
    await clickTextIfVisible(contexts, /^Standzeit$/i).catch(() => {});

    for (const ctx of contexts) {
      const enabled = ctx
        .locator(
          '[class*="toolbarButton_requestDecisionIcon"]:not([class*="disabled"])',
        )
        .first();
      try {
        if ((await enabled.count()) >= 1 && (await enabled.isVisible())) {
          await enabled.click({ timeout: 4000, force: true });
          return true;
        }
      } catch {
        // weiter versuchen
      }
    }
    await sleep(400);
  }

  // Fallback: direkte Attribut-Selektoren, falls die Klasse abweicht.
  for (const ctx of contexts) {
    const clicked = await clickFirstVisibleLocator([
      ctx.locator('[title*="Entscheidung einholen" i]'),
      ctx.locator('[aria-label*="Entscheidung" i]'),
    ]);
    if (clicked) return true;
  }

  return false;
}

function normalizeStopType(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (raw === "LOADING" || raw === "LOAD") return "LOADING";
  if (raw === "UNLOADING" || raw === "UNLOAD") return "UNLOADING";
  return "LOADING";
}

async function detectExistingStandgeld(contexts, { timeoutMs = 12000 } = {}) {
  // Duplikat-Schutz (GELD-KRITISCH). Das GXT-Zuschlags-Grid nutzt KEINE
  // <tr>-Elemente. Ausserdem existiert der Text "Standzeit"/"Referenzpreis"
  // MEHRFACH im DOM - u.a. als UNSICHTBARE div.cropText-Vorlage, die in
  // DOM-Reihenfolge ZUERST kommt. Deshalb ist getByText(...).first() unbrauchbar
  // (traf das unsichtbare Element). Wir scannen daher per evaluate ALLE Elemente
  // und zaehlen nur SICHTBARE Treffer (eigener Textknoten == "Standzeit").
  // Sicherheits-Gate: Erst wenn die Preis-Daten sicher geladen sind
  // (Referenzpreis sichtbar) duerfen wir "keine vorhanden" schliessen.
  //   Rueckgabe: { loaded: boolean, exists: boolean }
  //   loaded=false => Aufrufer MUSS abbrechen (kein Zuschlag), statt zu riskieren.
  const scan = async (ctx) => {
    try {
      return await ctx.evaluate(() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none";
        };
        const ownText = (el) => {
          let t = "";
          for (const node of el.childNodes) {
            if (node.nodeType === 3) t += node.textContent;
          }
          return t.trim();
        };
        let standzeit = 0;
        let referenz = 0;
        for (const el of Array.from(
          document.querySelectorAll("span, div, td, label"),
        )) {
          if (!isVisible(el)) continue;
          const own = ownText(el);
          if (!own) continue;
          if (/^Standzeit$/i.test(own)) standzeit += 1;
          else if (/Referenzpreis/i.test(own)) referenz += 1;
        }
        return { standzeit, referenz };
      });
    } catch {
      return { standzeit: 0, referenz: 0 };
    }
  };

  const deadline = Date.now() + timeoutMs;
  let priceLoaded = false;

  while (Date.now() < deadline) {
    for (const ctx of contexts) {
      const r = await scan(ctx);
      if (r.standzeit > 0) return { loaded: true, exists: true };
      if (r.referenz > 0) priceLoaded = true;
    }

    // Preis-Daten geladen und (bis hier) keine Standzeit gefunden: kurze
    // Nachprueffrist fuer verzoegertes Grid-Rendering, dann sicher entscheiden.
    if (priceLoaded) {
      const graceDeadline = Date.now() + 2000;
      while (Date.now() < graceDeadline) {
        for (const ctx of contexts) {
          const r = await scan(ctx);
          if (r.standzeit > 0) return { loaded: true, exists: true };
        }
        await sleep(300);
      }
      return { loaded: true, exists: false };
    }

    await sleep(300);
  }

  // Timeout ohne bestaetigte Preis-Daten: NICHT riskieren.
  return { loaded: false, exists: false };
}

async function applySurchargeForItem(frame, page, item, prelocatedRow) {
  const transportNumber = String(item?.transport_number || "").trim();
  if (!transportNumber) {
    throw new Error("Transportnummer fehlt.");
  }

  const stopType = normalizeStopType(item?.stop_type);
  const stationLabel =
    stopType === "UNLOADING" ? "Entladestelle" : "Beladestelle";
  const amount = Number(item?.amount_eur || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Betrag ist ungültig oder 0.");
  }

  const contexts = [frame, page];
  let row = prelocatedRow || null;
  if (!row) {
    const search = await searchAndLocateRow(frame, page, transportNumber);
    if (!search.found) {
      throw new Error("Transport konnte über Suche nicht gefunden werden.");
    }
    row = search.row;
  }

  const clicked = await clickTransportCell(frame, String(row?.text || ""));
  if (!clicked) {
    throw new Error("Transportzeile konnte nicht angeklickt werden.");
  }
  await sleep(400);

  // Duplikat-Schutz (GELD-KRITISCH): Preis-Reiter aktivieren und pruefen, ob
  // bereits IRGENDEINE "Standzeit"-Kostenzeile existiert. Falls ja, KEINEN
  // weiteren Zuschlag anlegen, ueberspringen und die Tour kennzeichnen. Falls die
  // Preisliste nicht sicher gelesen werden kann, wird ABGEBROCHEN (kein Zuschlag),
  // statt einen moeglichen Doppel-Eintrag zu riskieren.
  await waitForPriceTabActive(contexts).catch(() => {});
  await sleep(300);
  const existing = await detectExistingStandgeld(contexts);
  if (!existing.loaded) {
    throw new Error(
      "Preis-/Zuschlagsliste konnte nicht sicher gelesen werden. Kein Zuschlag gebucht (Sicherheitsabbruch gegen Doppel-Standgeld).",
    );
  }
  if (existing.exists) {
    return {
      transport_number: transportNumber,
      matched_transport_number: String(row?.text || ""),
      stop_type: stopType,
      station: stationLabel,
      amount_eur: amount,
      decision_requested: false,
      status: "already_exists",
    };
  }

  const dialogContext = await openSurchargeDialog(contexts);
  // Station + Beschreibung zuerst, Preis ZULETZT (Station-/Beschreibungswechsel
  // setzt das GXT-Preisfeld sonst wieder auf 0 zurueck).
  await selectStation(contexts, stationLabel);
  await fillDescription(dialogContext, String(item?.description || ""));
  await fillPriceFields(dialogContext, amount);
  await clickSave(dialogContext);
  const decisionRequested = await requestDecision(contexts);

  return {
    transport_number: transportNumber,
    matched_transport_number: String(row?.text || ""),
    stop_type: stopType,
    station: stationLabel,
    amount_eur: amount,
    decision_requested: decisionRequested,
    status: "applied",
  };
}

async function applyTransporeonSurcharges(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return {
      dryRun: Boolean(options.dryRun),
      processed: [],
      summary: {
        requested: 0,
        success_count: 0,
        failure_count: 0,
      },
    };
  }

  const dryRun = Boolean(options.dryRun);
  const headless = Boolean(options.headless);
  const keepBrowserOpen = options.keepBrowserOpen !== false;
  const perItemDelayMs = Number.isFinite(options.perItemDelayMs)
    ? Number(options.perItemDelayMs)
    : 250;

  const context = await getOrCreateContext({
    profileDir: options.profileDir,
    headless,
  });

  try {
    const pages = context.pages();
    const pageWithContent = pages.find((pageItem) => {
      const url = String(pageItem.url() || "").trim();
      return Boolean(url && url !== "about:blank");
    });
    const page = pageWithContent || pages[0] || (await context.newPage());

    let found = await waitForListFrame(context, {
      timeoutMs: Number.isFinite(options.waitForListInitialTimeoutMs)
        ? options.waitForListInitialTimeoutMs
        : 3000,
    });

    if (!found) {
      await page.goto(options.startUrl || START_URL, {
        waitUntil: "domcontentloaded",
      });
    }

    found =
      found ||
      (await waitForListFrame(context, {
        timeoutMs: Number.isFinite(options.waitForListTimeoutMs)
          ? options.waitForListTimeoutMs
          : 90000,
      }));

    if (!found) {
      throw new Error(
        "Keine Transporeon-Liste gefunden. Bitte mit dem Playwright-Profil einloggen und 'Zugewiesene Transporte' öffnen.",
      );
    }

    const { page: listPage, frame } = found;
    await scrollListToLoadAllRows(frame);
    await sleep(500);
    const processed = [];

    for (const item of list) {
      const transportNumber = String(item?.transport_number || "").trim();
      const stopType = normalizeStopType(item?.stop_type);
      const station =
        stopType === "UNLOADING" ? "Entladestelle" : "Beladestelle";

      const search = await searchAndLocateRow(frame, listPage, transportNumber);

      if (dryRun) {
        processed.push({
          transport_number: transportNumber,
          stop_type: stopType,
          station,
          amount_eur: Number(item?.amount_eur || 0),
          description: String(item?.description || ""),
          stop_key: String(item?.stop_key || "").trim() || null,
          status: search.found ? "ready" : "missing_transport",
          matched_transport_number: search.found
            ? String(search.row?.text || "")
            : null,
          message: search.found
            ? "Transport über Suche gefunden."
            : "Transport über Suche nicht gefunden.",
        });
        continue;
      }

      if (!search.found) {
        processed.push({
          transport_number: transportNumber,
          stop_type: stopType,
          station,
          amount_eur: Number(item?.amount_eur || 0),
          description: String(item?.description || ""),
          stop_key: String(item?.stop_key || "").trim() || null,
          status: "failed",
          message: "Transport über Suche nicht gefunden.",
        });
        continue;
      }

      try {
        const result = await applySurchargeForItem(
          frame,
          listPage,
          item,
          search.row,
        );
        processed.push({
          ...result,
          stop_key: String(item?.stop_key || "").trim() || null,
          description: String(item?.description || ""),
          message:
            result.status === "already_exists"
              ? "Es existiert bereits eine Standzeit-Kostenzeile. Kein weiterer Zuschlag gebucht."
              : "Zuschlag gespeichert und Entscheidung angefragt.",
        });
      } catch (error) {
        processed.push({
          transport_number: transportNumber,
          stop_type: stopType,
          station,
          amount_eur: Number(item?.amount_eur || 0),
          description: String(item?.description || ""),
          stop_key: String(item?.stop_key || "").trim() || null,
          status: "failed",
          message: String(error?.message || "Automatisierung fehlgeschlagen."),
        });
      }

      if (perItemDelayMs > 0) {
        await sleep(perItemDelayMs);
      }
    }

    const successCount = processed.filter((item) =>
      dryRun ? item.status === "ready" : item.status === "applied",
    ).length;

    const alreadyExistsCount = processed.filter(
      (item) => item.status === "already_exists",
    ).length;

    const failureCount = processed.length - successCount - alreadyExistsCount;

    return {
      dryRun,
      processed,
      summary: {
        requested: list.length,
        success_count: successCount,
        already_exists_count: alreadyExistsCount,
        failure_count: failureCount,
      },
    };
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("Target page, context or browser has been closed")) {
      activeContext = null;
    }
    throw error;
  } finally {
    if (!keepBrowserOpen) {
      await closeActiveContext();
    }
  }
}

// Oeffnet (oder verwendet) das dauerhaft offene Automations-Fenster und navigiert
// es zu Transporeon. Der Nutzer loggt sich EINMAL in genau diesem Fenster ein und
// oeffnet "Zugewiesene Transporte". Danach steuert die Automatisierung dasselbe,
// eingeloggte Fenster - deshalb sind die Touren sichtbar und die Suche findet sie.
async function openTransporeonSession(options = {}) {
  const context = await getOrCreateContext({
    profileDir: options.profileDir,
    headless: false,
  });

  const pages = context.pages();
  const page =
    pages.find((pageItem) => {
      const url = String(pageItem.url() || "").trim();
      return Boolean(url && url !== "about:blank");
    }) ||
    pages[0] ||
    (await context.newPage());

  const currentUrl = String(page.url() || "");
  if (!/transporeon/i.test(currentUrl)) {
    await page
      .goto(options.startUrl || START_URL, { waitUntil: "domcontentloaded" })
      .catch(() => {});
  }
  await page.bringToFront().catch(() => {});

  const found = await waitForListFrame(context, {
    timeoutMs: Number.isFinite(options.waitForListTimeoutMs)
      ? options.waitForListTimeoutMs
      : 2500,
  });

  let rowCount = 0;
  if (found) {
    await scrollListToLoadAllRows(found.frame).catch(() => {});
    await sleep(300);
    rowCount = (await collectTransportRows(found.frame)).length;
  }

  return {
    opened: true,
    list_ready: Boolean(found),
    row_count: rowCount,
    message: found
      ? `Automations-Fenster bereit. ${rowCount} Transportzeilen erkannt.`
      : "Automations-Fenster ge\u00f6ffnet. Bitte in DIESEM Fenster bei Transporeon einloggen und 'Zugewiesene Transporte' \u00f6ffnen.",
  };
}

// Liest alle sichtbaren, potenziell klickbaren Toolbar-Elemente aus allen Frames
// aus, damit der '+'-Button und die weiteren Steuer-Icons kalibriert werden koennen.
async function inspectSurchargeControls() {
  const context = await getOrCreateContext({ headless: false });
  const out = [];

  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      let items = [];
      try {
        items = await frame.evaluate(() => {
          const results = [];
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 3 || rect.height < 3) return false;
            const style = window.getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none") {
              return false;
            }
            return true;
          };

          const nodes = Array.from(
            document.querySelectorAll(
              "[title], [aria-label], [role='button'], button, [class*='icon'], [class*='Icon'], [class*='btn'], [class*='tool'], [class*='Tool']",
            ),
          );

          for (const el of nodes) {
            if (!isVisible(el)) continue;
            const title = el.getAttribute("title") || "";
            const aria = el.getAttribute("aria-label") || "";
            const text = String(el.textContent || "")
              .trim()
              .slice(0, 40);
            const cls = String(el.className || "").slice(0, 120);
            const relevant =
              /hinzu|zuschlag|add|plus|entscheid|einhol|speicher|save|toolbarButton|preis|ladeauftrag/i.test(
                `${title} ${aria} ${text} ${cls}`,
              ) ||
              text === "+" ||
              text === "?";
            if (!relevant) continue;

            results.push({
              tag: el.tagName.toLowerCase(),
              title: title.slice(0, 80),
              aria: aria.slice(0, 80),
              text,
              cls,
            });
          }
          return results.slice(0, 60);
        });
      } catch {
        // ignore inaccessible frames
      }

      if (items.length) {
        out.push({
          frameUrl: String(frame.url() || "").slice(0, 120),
          controls: items,
        });
      }
    }
  }

  return { frames: out };
}

// Klickt das '+' (toolbarButton_add), oeffnet den Dialog 'Zuschlag hinzufuegen'
// und liest dessen Felder (Preis-Inputs, Station-Auswahl, Beschreibung, Speichern,
// Entscheidung) aus, damit der komplette Dialog-Ablauf kalibriert werden kann.
async function debugOpenSurchargeDialog() {
  const context = await getOrCreateContext({ headless: false });
  const found = await findListFrame(context);
  const frame = found?.frame;
  if (!frame) {
    return { error: "Kein Detail-Frame gefunden." };
  }

  let clicked = false;
  try {
    const add = frame.locator('[class*="toolbarButton_add"]').first();
    if (await add.count()) {
      await add.click({ timeout: 5000, force: true });
      clicked = true;
    }
  } catch (error) {
    return { error: `Klick auf '+' fehlgeschlagen: ${error.message}` };
  }

  await sleep(1500);

  const dialog = await frame.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    const inputs = Array.from(document.querySelectorAll("input"))
      .filter(isVisible)
      .map((el) => ({
        type: el.getAttribute("type") || "text",
        placeholder: el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        name: el.getAttribute("name") || "",
        value: String(el.value || "").slice(0, 30),
        cls: String(el.className || "").slice(0, 100),
      }));

    const textareas = Array.from(document.querySelectorAll("textarea"))
      .filter(isVisible)
      .map((el) => ({
        placeholder: el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        cls: String(el.className || "").slice(0, 100),
      }));

    const buttons = Array.from(
      document.querySelectorAll(
        "button, [role='button'], [class*='Button'], [class*='button']",
      ),
    )
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: String(el.textContent || "")
          .trim()
          .slice(0, 30),
        title: el.getAttribute("title") || "",
        cls: String(el.className || "").slice(0, 100),
      }))
      .filter((b) => b.text || b.title)
      .slice(0, 40);

    const stationHints = Array.from(document.querySelectorAll("*"))
      .filter(
        (el) =>
          isVisible(el) &&
          /Beladestelle|Entladestelle|Bitte ausw|Ladestelle/i.test(
            el.textContent || "",
          ) &&
          (el.children.length === 0 ||
            String(el.textContent || "").length < 40),
      )
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: String(el.textContent || "")
          .trim()
          .slice(0, 40),
        cls: String(el.className || "").slice(0, 100),
      }))
      .slice(0, 15);

    const hasDialog = /Zuschlag hinzuf/i.test(document.body.innerText || "");

    return { hasDialog, inputs, textareas, buttons, stationHints };
  });

  return { clicked, ...dialog };
}

// Oeffnet den Transport und liest die Detail-Reiterleiste aus, damit der
// 'Preis'-Reiter (Icon-Tab, verschleierte Klassen) exakt bestimmt werden kann.
async function debugDetailTabs(transportNumber) {
  const context = await getOrCreateContext({ headless: false });
  const found = await findListFrame(context);
  if (!found) return { error: "Kein Listen-Frame gefunden." };
  const { page, frame } = found;

  let opened = false;
  if (transportNumber) {
    const search = await searchAndLocateRow(frame, page, transportNumber);
    if (search.found) {
      opened = await clickTransportCell(frame, String(search.row?.text || ""));
      await sleep(1800);
    }
  }

  const tabs = await frame.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    // Anker: das Text-Label "Ladeauftrag" oder "Preis" in der Reiterleiste.
    const labels = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        isVisible(el) &&
        el.children.length === 0 &&
        /^(Ladeauftrag|Preis)$/i.test(String(el.textContent || "").trim()),
    );

    let strip = null;
    for (const label of labels) {
      let node = label;
      for (let i = 0; i < 5 && node; i += 1) {
        node = node.parentElement;
        if (node && node.querySelectorAll("*").length > 6) {
          strip = node;
          break;
        }
      }
      if (strip) break;
    }

    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      title: el.getAttribute("title") || "",
      aria: el.getAttribute("aria-label") || "",
      text: String(el.textContent || "")
        .trim()
        .slice(0, 20),
      cls: String(el.className || "").slice(0, 120),
    });

    const stripChildren = strip
      ? Array.from(strip.querySelectorAll("*"))
          .filter(isVisible)
          .map(describe)
          .filter(
            (d) =>
              d.title ||
              d.aria ||
              d.text ||
              /tab|reiter|icon|button/i.test(d.cls),
          )
          .slice(0, 40)
      : [];

    return {
      stripHtml: strip ? String(strip.outerHTML || "").slice(0, 3000) : "",
      stripChildren,
    };
  });

  return { opened, ...tabs };
}

// Oeffnet den Transport, klickt den Preis-Reiter und liest den Inhalt aus
// (Zuschlaege-Bereich + alle Toolbar-/Plus-Buttons), um den '+' exakt zu finden.
async function debugPriceTabContent(transportNumber) {
  const context = await getOrCreateContext({ headless: false });
  const found = await findListFrame(context);
  if (!found) return { error: "Kein Listen-Frame gefunden." };
  const { page, frame } = found;

  let opened = false;
  if (transportNumber) {
    const search = await searchAndLocateRow(frame, page, transportNumber);
    if (search.found) {
      opened = await clickTransportCell(frame, String(search.row?.text || ""));
      await sleep(1500);
    }
  }

  const tabClicked = await clickPriceTab([frame, page]).catch(() => false);
  await sleep(1200);

  const content = await frame.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      title: el.getAttribute("title") || "",
      qtip: el.getAttribute("qtip") || "",
      aria: el.getAttribute("aria-label") || "",
      text: String(el.textContent || "")
        .trim()
        .slice(0, 30),
      cls: String(el.className || "").slice(0, 120),
    });

    // Alle Toolbar-artigen Buttons.
    const toolbarButtons = Array.from(
      document.querySelectorAll(
        "[class*='toolbarButton'], [class*='Button'], [class*='button'], [role='button']",
      ),
    )
      .filter(isVisible)
      .map(describe)
      .slice(0, 60);

    // Kandidaten fuer '+' / hinzufuegen / Zuschlag.
    const addCandidates = Array.from(document.querySelectorAll("*"))
      .filter(
        (el) =>
          isVisible(el) &&
          (el.children.length === 0 ||
            String(el.textContent || "").length < 40) &&
          (/hinzuf|zuschlag/i.test(
            (el.getAttribute("title") || "") +
              (el.getAttribute("qtip") || "") +
              (el.getAttribute("aria-label") || ""),
          ) ||
            String(el.textContent || "").trim() === "+"),
      )
      .map(describe)
      .slice(0, 30);

    const priceTabActive = !!document.querySelector(
      "li.transportPriceItemsTab.tabStripActive, li.transportPriceItemsTab[class*='Active']",
    );

    const bodyText = String(document.body.innerText || "");
    const hasZuschlaege = /Zuschl[aä]ge/i.test(bodyText);

    return { priceTabActive, hasZuschlaege, toolbarButtons, addCandidates };
  });

  return { opened, tabClicked, ...content };
}

// TROCKENLAUF-PRUEFUNG (Geld-sicher): Oeffnet einen Transport, aktiviert den
// Preis-Reiter und prueft NUR, ob der Motor Standgeld beantragen WUERDE. Es wird
// NIEMALS ein Zuschlag-Dialog geoeffnet oder gespeichert. Liefert ausserdem die
// echte Grid-Struktur (Elemente rund um "Standzeit"/"Referenzpreis"), damit wir
// sehen, was der Motor tatsaechlich lesen kann.
async function dryRunStandgeldCheck(transportNumber) {
  const context = await getOrCreateContext({ headless: false });
  const found = await findListFrame(context);
  if (!found) {
    return {
      error:
        "Kein Listen-Frame gefunden. Bitte im Automations-Fenster einloggen und 'Zugewiesene Transporte' oeffnen.",
    };
  }
  const { page, frame } = found;
  const contexts = [frame, page];

  let opened = false;
  let matchedRow = "";
  if (transportNumber) {
    const search = await searchAndLocateRow(frame, page, transportNumber);
    if (!search.found) {
      return { error: `Transport ${transportNumber} nicht gefunden.` };
    }
    matchedRow = String(search.row?.text || "");
    opened = await clickTransportCell(frame, matchedRow);
    await sleep(1200);
  }

  const priceActive = await waitForPriceTabActive(contexts).catch(() => false);
  await sleep(400);

  const detection = await detectExistingStandgeld(contexts);

  // Echte Grid-Struktur auslesen: alle Elemente, deren EIGENER Text (ohne
  // verschachtelte Kinder) "Standzeit" bzw. "Referenzpreis" enthaelt.
  const dumpFrom = async (ctx) => {
    try {
      return await ctx.evaluate(() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none";
        };
        const ownText = (el) => {
          let t = "";
          for (const node of el.childNodes) {
            if (node.nodeType === 3) t += node.textContent;
          }
          return t.trim();
        };
        const describe = (el) => ({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || "").slice(0, 120),
          visible: isVisible(el),
          text: String(el.textContent || "")
            .trim()
            .slice(0, 80),
        });
        const standzeitOwn = [];
        const referenzOwn = [];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const own = ownText(el);
          if (!own) continue;
          if (/^Standzeit$/i.test(own)) standzeitOwn.push(describe(el));
          else if (/Referenzpreis/i.test(own)) referenzOwn.push(describe(el));
        }
        const body = String(document.body.innerText || "");
        return {
          standzeitExactCount: standzeitOwn.length,
          standzeitVisibleCount: standzeitOwn.filter((d) => d.visible).length,
          standzeitElements: standzeitOwn.slice(0, 10),
          referenzElements: referenzOwn.slice(0, 5),
          hasStandzeitWordAnywhere: /Standzeit/i.test(body),
          detailTextSnippet: body.slice(0, 1500),
        };
      });
    } catch (error) {
      return { evaluateError: String(error?.message || error) };
    }
  };

  const frameDump = await dumpFrom(frame);
  const pageDump = await dumpFrom(page);

  let verdict;
  if (!detection.loaded) {
    verdict =
      "ABBRUCH: Preisliste nicht sicher lesbar -> es wuerde KEIN Zuschlag gebucht.";
  } else if (detection.exists) {
    verdict =
      "UEBERSPRINGEN: Es existiert bereits eine Standzeit-Zeile -> kein neuer Zuschlag.";
  } else {
    verdict =
      "WUERDE BEANTRAGEN: Keine vorhandene Standzeit-Zeile -> Motor wuerde einen Zuschlag anlegen (hier NICHT gespeichert).";
  }

  return {
    transport_number: transportNumber || null,
    matched_row: matchedRow || null,
    opened,
    price_tab_active: priceActive,
    detection,
    verdict,
    frame_dump: frameDump,
    page_dump: pageDump,
  };
}

// Oeffnet den kompletten Zuschlag-Dialog und listet ALLE sichtbaren Eingabefelder
// mit Position/Label/Wert auf, um das Preisfeld exakt zu bestimmen.
async function debugSurchargeDialogFields(transportNumber) {
  const context = await getOrCreateContext({ headless: false });
  const found = await findListFrame(context);
  if (!found) return { error: "Kein Listen-Frame gefunden." };
  const { page, frame } = found;

  let opened = false;
  if (transportNumber) {
    const search = await searchAndLocateRow(frame, page, transportNumber);
    if (search.found) {
      opened = await clickTransportCell(frame, String(search.row?.text || ""));
      await sleep(1200);
    }
  }

  let dialogOpened = false;
  try {
    await openSurchargeDialog([frame, page]);
    dialogOpened = true;
  } catch (error) {
    return { opened, dialogOpened, error: error.message };
  }

  await sleep(600);

  const fields = await frame.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    // Nur Felder im obersten Dialog-Layer (hoechster z-index / modal).
    const labelFor = (el) => {
      // naechstgelegenes Label-artiges Geschwister/Vorfahr-Text.
      let node = el;
      for (let i = 0; i < 4 && node; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const txt = String(node.textContent || "").trim();
        if (txt && txt.length < 60) return txt.slice(0, 50);
      }
      return "";
    };

    const inputs = Array.from(document.querySelectorAll("input"))
      .filter(isVisible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          type: el.getAttribute("type") || "text",
          name: el.getAttribute("name") || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: String(el.value || "").slice(0, 30),
          cls: String(el.className || "").slice(0, 90),
          label: labelFor(el),
        };
      });

    const textareas = Array.from(document.querySelectorAll("textarea"))
      .filter(isVisible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          value: String(el.value || "").slice(0, 40),
          cls: String(el.className || "").slice(0, 90),
          label: labelFor(el),
        };
      });

    return { inputs, textareas };
  });

  return { opened, dialogOpened, ...fields };
}

module.exports = {
  applyTransporeonSurcharges,
  openTransporeonSession,
  inspectSurchargeControls,
  debugOpenSurchargeDialog,
  debugDetailTabs,
  debugPriceTabContent,
  debugSurchargeDialogFields,
  dryRunStandgeldCheck,
};
