"use strict";

const path = require("node:path");
const { chromium } = require("playwright");

const { normalizeTransportNumber } = require("../normalize/exportBilling");

const PROFILE_DIR = path.join(process.cwd(), ".pw-profile");
const START_URL =
  "https://login.transporeon.com/?locale=de&return=AssignedTransportsCarrier";
const NUMBER_CELL = 'td[class*="gxColumn-number"] div.taMJE';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTransportLoose(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalizeTransportNumber(raw) || raw;
}

async function findListFrame(context) {
  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      try {
        const has = await frame.evaluate(
          () => !!document.querySelector('td[class*="gxColumn-number"]'),
        );
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
    const normalizeDigits = (text) => {
      const match = String(text || "")
        .trim()
        .match(/(\d{10})$/);
      return match ? match[1] : String(text || "").trim();
    };

    const cells = Array.from(
      document.querySelectorAll('td[class*="gxColumn-number"] div.taMJE'),
    );

    return cells.map((cell, index) => {
      const text = String(cell.textContent || "").trim();
      const norm = normalizeDigits(text);
      const last7 = norm.replace(/\D/g, "").slice(-7);
      return { index, text, norm, last7 };
    });
  });

  return Array.isArray(rows) ? rows : [];
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

async function openSurchargeDialog(contexts) {
  await clickTextIfVisible(contexts, /^Preis$/i).catch(() => {});
  await clickTextIfVisible(contexts, /Zuschl[aä]ge/i).catch(() => {});

  for (const ctx of contexts) {
    const clicked = await clickFirstVisibleLocator(contextLocators(ctx));
    if (clicked) break;
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const ctx of contexts) {
      try {
        const title = ctx.getByText(/Zuschlag hinzuf[üu]gen/i).first();
        if (await title.isVisible()) {
          return ctx;
        }
      } catch {
        // continue
      }
    }
    await sleep(250);
  }

  throw new Error(
    "Dialog 'Zuschlag hinzufügen' wurde nicht gefunden (Plus-Button/Panel prüfen).",
  );
}

async function fillPriceFields(context, amountEur) {
  const cents = Math.max(0, Math.round(Number(amountEur || 0) * 100));
  const euros = Math.floor(cents / 100);
  const centPart = String(cents % 100).padStart(2, "0");

  const inputs = context.locator("input:not([type='hidden']):not([disabled])");
  const numericInputs = [];

  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    try {
      if (!(await input.isVisible())) continue;
      const value = String(await input.inputValue()).trim();
      if (/^\d*$/.test(value)) numericInputs.push(input);
    } catch {
      // ignore read issues
    }
  }

  if (!numericInputs.length) {
    throw new Error("Preisfeld wurde nicht erkannt.");
  }

  await numericInputs[0].fill(String(euros));
  if (numericInputs[1]) {
    await numericInputs[1].fill(centPart);
  }
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

async function selectStation(contexts, stationLabel) {
  const station = String(stationLabel || "").trim();
  if (!station) return;

  for (const ctx of contexts) {
    try {
      const chooser = ctx.getByText(/Bitte ausw[aä]hlen/i).first();
      if (await chooser.isVisible()) {
        await chooser.click({ timeout: 4000, force: true });
      }
      const option = ctx.getByText(new RegExp(station, "i")).first();
      if (await option.isVisible()) {
        await option.click({ timeout: 4000, force: true });
        return;
      }
    } catch {
      // try fallback
    }
  }

  for (const ctx of contexts) {
    try {
      const inputs = ctx.locator("input:not([type='hidden']):not([disabled])");
      const count = await inputs.count();
      for (let i = count - 1; i >= 0; i -= 1) {
        const input = inputs.nth(i);
        if (!(await input.isVisible())) continue;
        const value = String(await input.inputValue()).trim();
        if (/^\d*$/.test(value)) continue;
        await input.fill(station);
        await ctx.page().keyboard.press("Enter");
        return;
      }
    } catch {
      // continue
    }
  }

  throw new Error(
    `Ladestelle/Entladestelle konnte nicht auf '${station}' gesetzt werden.`,
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
      const dialogTitle = context.getByText(/Zuschlag hinzuf[üu]gen/i).first();
      if (!(await dialogTitle.isVisible())) return;
    } catch {
      return;
    }
    await sleep(250);
  }
}

async function requestDecision(contexts) {
  await clickTextIfVisible(contexts, /^Standzeit$/i).catch(() => {});

  for (const ctx of contexts) {
    const clicked = await clickFirstVisibleLocator([
      ctx.locator('[title*="Entscheidung einholen" i]'),
      ctx.locator('[aria-label*="Entscheidung" i]'),
      ctx.locator("button:has-text('?')"),
    ]);
    if (clicked) return;
  }

  throw new Error("Button 'Entscheidung einholen' wurde nicht gefunden.");
}

function normalizeStopType(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (raw === "LOADING" || raw === "LOAD") return "LOADING";
  if (raw === "UNLOADING" || raw === "UNLOAD") return "UNLOADING";
  return "LOADING";
}

async function applySurchargeForItem(frame, page, transportRows, item) {
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

  const row = resolveRowMatch(transportRows, transportNumber);
  if (!row) {
    throw new Error("Transport in aktueller Liste nicht gefunden.");
  }

  const cell = frame.locator(NUMBER_CELL).nth(Number(row.index));
  await cell.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await cell.click({ timeout: 5000, force: true });
  await sleep(250);

  const contexts = [frame, page];
  const dialogContext = await openSurchargeDialog(contexts);
  await fillPriceFields(dialogContext, amount);
  await fillDescription(dialogContext, String(item?.description || ""));
  await selectStation(contexts, stationLabel);
  await clickSave(dialogContext);
  await requestDecision(contexts);

  return {
    transport_number: transportNumber,
    matched_transport_number: row.text,
    stop_type: stopType,
    station: stationLabel,
    amount_eur: amount,
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
  const perItemDelayMs = Number.isFinite(options.perItemDelayMs)
    ? Number(options.perItemDelayMs)
    : 250;

  const context = await chromium.launchPersistentContext(
    options.profileDir || PROFILE_DIR,
    {
      headless,
      viewport: { width: 1680, height: 980 },
      locale: "de-DE",
    },
  );

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(options.startUrl || START_URL, {
      waitUntil: "domcontentloaded",
    });

    const found = await waitForListFrame(context, {
      timeoutMs: Number.isFinite(options.waitForListTimeoutMs)
        ? options.waitForListTimeoutMs
        : 90000,
    });

    if (!found) {
      throw new Error(
        "Keine Transporeon-Liste gefunden. Bitte mit dem Playwright-Profil einloggen und 'Zugewiesene Transporte' öffnen.",
      );
    }

    const { page: listPage, frame } = found;
    await scrollListToLoadAllRows(frame);
    await sleep(500);

    const transportRows = await collectTransportRows(frame);
    if (!transportRows.length) {
      throw new Error(
        "Keine Transportzeilen gefunden. Bitte Liste in Transporeon laden und erneut starten.",
      );
    }

    const processed = [];

    for (const item of list) {
      const transportNumber = String(item?.transport_number || "").trim();
      const stopType = normalizeStopType(item?.stop_type);
      const rowMatch = resolveRowMatch(transportRows, transportNumber);
      const station =
        stopType === "UNLOADING" ? "Entladestelle" : "Beladestelle";

      if (dryRun) {
        processed.push({
          transport_number: transportNumber,
          stop_type: stopType,
          station,
          amount_eur: Number(item?.amount_eur || 0),
          description: String(item?.description || ""),
          stop_key: String(item?.stop_key || "").trim() || null,
          status: rowMatch ? "ready" : "missing_transport",
          matched_transport_number: rowMatch ? rowMatch.text : null,
          message: rowMatch
            ? "Transport in Liste gefunden."
            : "Transport in aktueller Liste nicht gefunden.",
        });
        continue;
      }

      try {
        const result = await applySurchargeForItem(
          frame,
          listPage,
          transportRows,
          item,
        );
        processed.push({
          ...result,
          stop_key: String(item?.stop_key || "").trim() || null,
          description: String(item?.description || ""),
          message: "Zuschlag gespeichert und Entscheidung angefragt.",
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

    const failureCount = processed.length - successCount;

    return {
      dryRun,
      processed,
      summary: {
        requested: list.length,
        success_count: successCount,
        failure_count: failureCount,
      },
    };
  } finally {
    if (!Boolean(options.keepBrowserOpen)) {
      await context.close().catch(() => {});
    }
  }
}

module.exports = {
  applyTransporeonSurcharges,
};
