import type { RawRate } from "./rates.js";
import type { Page } from "playwright";

export const RATE_ROWS = '[data-testid="rate-card"], [data-rate-plan-code], .rate-plan-card, .rate-card-content';
export const RATE_RESULTS = `${RATE_ROWS}, [data-testid="RateCardV2"]`;
export const NO_ROOMS = '[data-testid="no-availability"], [data-testid="no-results"], .no-availability';

/** Runs inside the page. Keep self-contained for Playwright serialization. */
export function extractRateRows(): RawRate[] {
  const visible = (element: Element | null) => {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const clean = (value?: string | null) => value?.replace(/\s+/g, " ").trim() || "";
  const currentDetails = Array.from(document.querySelectorAll('[data-testid="RateCardV2"] .rate-card-content [data-testid="ratedetails"]'))
    .filter(row => row.querySelector('button[aria-label^="Select "]') && visible(row.closest('[data-testid="RateCardV2"]')));
  if (currentDetails.length) {
    return currentDetails.map(row => {
      const card = row.closest('.rate-card-content')!;
      const room = row.closest('[data-testid="RateCardV2"]')!;
      const ruleLink = row.querySelector<HTMLAnchorElement>('a[data-testid="rate-modal"][href*="rateProgramCode="][href*="productId="]');
      const roomLink = room.querySelector<HTMLAnchorElement>('a[href*="ersViewRoomPool.mi"][href*="roomPoolCode="]');
      const ruleUrl = ruleLink ? new URL(ruleLink.href, location.href) : null;
      const roomUrl = roomLink ? new URL(roomLink.href, location.href) : null;
      const ratePlanCode = ruleUrl?.searchParams.get("rateProgramCode") || "";
      const roomCode = roomUrl?.searchParams.get("roomPoolCode") || "";
      const hotelId = roomUrl?.searchParams.get("marshaCode") || "";
      const pageDate = (name: string) => {
        const raw = Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)).find(input => input.value)?.value || "";
        return raw.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2");
      };
      let product: string[] = [];
      try {
        const encoded = ruleUrl?.searchParams.get("productId") || "";
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
        product = atob(normalized).split("|");
      } catch {}
      const identityVerified = product.length >= 5 && product[0]?.toUpperCase() === hotelId.toUpperCase()
        && product[1]?.toUpperCase() === ratePlanCode.toUpperCase()
        && product[2]?.toUpperCase() === roomCode.toUpperCase()
        && product[3] === pageDate("fromDate") && product[4] === pageDate("toDate");
      const heading = clean(card.querySelector('.title-name')?.textContent);
      const variant = clean(row.querySelector('.rate-name')?.textContent);
      const description = clean(card.querySelector('.rate-description')?.textContent);
      const labelElements = Array.from(card.querySelectorAll('.taxes-fees-label'));
      const cancellationPolicy = labelElements.map(el => clean(el.textContent)).find(text => /cancel|refund/i.test(text))
        || (/non[ -]?refundable|no refunds|prepay/i.test(`${heading} ${description}`) ? clean(`${heading}. ${description}`) : "");
      const deadline = cancellationPolicy.match(/(?:before(?: or on)?|until)\s+(.+?)(?:\.|$)/i)?.[1] || "";
      const depositPolicy = /deposit|prepay|advance payment/i.test(description) ? description : "";
      const price = row.querySelector('.price');
      const amount = Array.from(price?.children || []).find(el => el.tagName === "SPAN" && visible(el));
      const currency = clean(price?.querySelector('.avg-per-night')?.textContent).match(/\b([A-Z]{3})\b/)?.[1] || "";
      const totalText = Array.from(row.querySelectorAll('.avg-per-night')).map(el => ({ el, text: clean(el.textContent) }))
        .find(item => /total per room/i.test(item.text) && visible(item.el))?.text || "";
      const totalAmount = totalText.match(/[\d][\d., ]*/)?.[0]?.trim() || "";
      const select = row.querySelector<HTMLButtonElement>('button[aria-label^="Select "]');
      return {
        code: identityVerified ? roomCode.toUpperCase() : "",
        name: clean(room.querySelector('.room-name')?.textContent),
        ratePlanCode: identityVerified ? ratePlanCode.toUpperCase() : "",
        ratePlanName: clean([heading, variant].filter(Boolean).join(" — ")),
        nightly: currency && amount ? `${currency} ${clean(amount.textContent)}` : "",
        total: currency && totalAmount ? `${currency} ${totalAmount}` : "",
        currency,
        taxesIncluded: labelElements.some(el => /taxes and all fees included/i.test(clean(el.textContent)) && visible(el)),
        cancellationPolicy,
        cancellationDeadline: deadline,
        depositPolicy,
        eligibility: description,
        available: Boolean(select && !select.disabled && select.getAttribute("aria-disabled") !== "true"),
        bookingUrl: "",
        points: clean(row.querySelector('[data-testid="total-points"], .total-points')?.textContent),
      };
    });
  }

  const rateSelector = '[data-testid="rate-card"], [data-rate-plan-code], .rate-plan-card';
  const cards = Array.from(document.querySelectorAll('[data-testid="rate-card"], .rate-plan-card'));
  const rows = cards.length ? cards.filter(row => !row.parentElement?.closest('[data-testid="rate-card"], .rate-plan-card'))
    : Array.from(document.querySelectorAll('[data-rate-plan-code]')).filter(row => !row.matches("a, button") && !row.querySelector(rateSelector));
  return rows.filter(visible).map(row => {
    const room = row.closest('[data-room-type-code], [data-room-code], [data-testid="room-type-card"], .room-type');
    const text = (selector: string) => clean(row.querySelector(selector)?.textContent);
    const attr = (name: string) => row.getAttribute(name) || "";
    const link = row.querySelector<HTMLAnchorElement>('a[data-testid="select-rate"], a[href*="reservation/"], a[href*="rateListMenu"]');
    const button = row.querySelector<HTMLButtonElement>('button[data-testid="select-rate"], button[name="selectRate"]');
    const url = link ? new URL(link.href, location.href) : null;
    return {
      code: attr("data-room-type-code") || attr("data-room-code") || room?.getAttribute("data-room-type-code") || room?.getAttribute("data-room-code") || url?.searchParams.get("roomTypeCode") || "",
      name: clean(room?.querySelector('[data-testid="room-name"], .room-name, h2, h3')?.textContent),
      ratePlanCode: attr("data-rate-plan-code") || attr("data-rate-plan") || row.querySelector('[data-rate-plan-code]')?.getAttribute("data-rate-plan-code") || url?.searchParams.get("ratePlanCode") || "",
      ratePlanName: text('[data-testid="rate-name"], .rate-plan-name, [class*="ratePlanName"]'),
      nightly: text('[data-testid="nightly-price"], .nightly-price'),
      total: text('[data-testid="total-price"], [data-testid="stay-total"], .total-price'),
      currency: attr("data-currency") || row.querySelector('[data-currency]')?.getAttribute("data-currency") || "",
      taxesIncluded: attr("data-taxes-included") === "true" || /(?:includes|including) (?:all )?taxes (?:and|&) (?:all )?fees/i.test(text('[data-testid="taxes-fees"], .taxes-fees')),
      cancellationPolicy: text('[data-testid="cancellation-policy"], .cancellation-policy'),
      cancellationDeadline: row.querySelector('[data-testid="cancellation-deadline"], .cancellation-deadline')?.getAttribute("datetime") || text('[data-testid="cancellation-deadline"], .cancellation-deadline'),
      depositPolicy: text('[data-testid="deposit-policy"], .deposit-policy'),
      eligibility: text('[data-testid="rate-eligibility"], .rate-eligibility'),
      available: attr("data-available") !== "false" && (Boolean(link && link.getAttribute("aria-disabled") !== "true") || Boolean(button && !button.disabled)),
      bookingUrl: url?.href || "",
      points: text('[data-testid="total-points"], .total-points'),
    };
  });
}

/** Expand current room cards and display full prices. Neither action selects a rate. */
export async function prepareRateList(page: Page): Promise<void> {
  const taxToggle = page.locator('input[data-testid="showFullPrice"]:visible');
  if (await taxToggle.count() === 1 && !await taxToggle.isChecked()) {
    // Marriott visually overlays the checkbox with its label, so a pointer-driven
    // check is intercepted. The native click still runs the page's change handler.
    await taxToggle.evaluate((input: HTMLInputElement) => input.click());
    if (!await taxToggle.isChecked()) throw new Error("PAGE_CHANGED: Tax-inclusive display could not be enabled.");
  }
  for (let count = 0; count < 100; count++) {
    const button = page.locator('[data-testid="RateCardV2"]:visible button[data-testid="rate-button"]')
      .filter({ hasText: /^\s*View Rates\s*$/ }).first();
    if (!await button.count()) break;
    const before = await page.locator('[data-testid="RateCardV2"]:visible .rate-card-content:visible').count();
    await button.click();
    await page.waitForFunction(previous => Array.from(document.querySelectorAll('[data-testid="RateCardV2"] .rate-card-content'))
      .filter(element => element.getClientRects().length && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden").length > previous, before, { timeout: 10000 });
  }
}

export async function currentRateListComplete(page: Page): Promise<boolean> {
  const rooms = page.locator('[data-testid="RateCardV2"]:visible');
  if (!await rooms.count()) return false;
  return await rooms.locator('button[data-testid="rate-button"]').filter({ hasText: /^\s*View Rates\s*$/ }).count() === 0;
}

/** Expand only explicitly labelled legacy rate-details controls, retaining row identity. */
export async function collectRateRows(page: Page): Promise<RawRate[]> {
  await prepareRateList(page);
  const collected = await page.evaluate(extractRateRows);
  // The current information icon has SPA behavior that can select a room. Its visible
  // cancellation text is parsed, while unshown guarantee/deposit terms stay unknown.
  if (await page.locator('[data-testid="RateCardV2"]:visible').count()) return collected;
  const cards = page.locator('[data-testid="rate-card"], .rate-plan-card');
  for (let i = 0; i < Math.min(await cards.count(), 100); i++) {
    const card = cards.nth(i);
    const control = card.locator('button[data-testid="rate-details"], button[aria-controls]').filter({ hasText: /rate details/i });
    if (await control.count() !== 1 || !await control.isVisible()) continue;
    const before = await page.evaluate(extractRateRows);
    const planCode = await card.getAttribute("data-rate-plan-code");
    const matching = before.filter(row => row.ratePlanCode === planCode);
    const identity = matching.length === 1 ? matching[0] : undefined;
    if (!identity) continue;
    if (await page.locator('[role="dialog"]:visible').count()) throw new Error("PAGE_CHANGED: An unrelated dialog is open.");
    await control.click();
    const dialog = page.locator('[role="dialog"]:visible');
    const scope = await dialog.count() === 1 ? dialog : card;
    try {
      await scope.locator('[data-testid="cancellation-policy"], .cancellation-policy').first().waitFor({ state: "visible", timeout: 3000 });
      const details = await scope.evaluate(root => {
        const text = (s: string) => root.querySelector(s)?.textContent?.trim() || "";
        return {
          cancellationPolicy: text('[data-testid="cancellation-policy"], .cancellation-policy'),
          cancellationDeadline: root.querySelector('[data-testid="cancellation-deadline"], .cancellation-deadline')?.getAttribute("datetime") || text('[data-testid="cancellation-deadline"], .cancellation-deadline'),
          depositPolicy: text('[data-testid="deposit-policy"], .deposit-policy'),
          eligibility: text('[data-testid="rate-eligibility"], .rate-eligibility'),
        };
      });
      const target = collected.find(r => r.code === identity.code && r.ratePlanCode === identity.ratePlanCode);
      if (target) for (const key of Object.keys(details) as (keyof typeof details)[]) if (details[key]) target[key] = details[key];
    } catch {
      // Missing terms stay unknown. Do not borrow another rate's policy.
    } finally {
      if (await dialog.count() === 1) {
        const close = dialog.getByRole("button", { name: /close/i });
        if (await close.count() !== 1) throw new Error("PAGE_CHANGED: Rate details dialog could not be closed safely.");
        await close.click();
      }
    }
  }
  return collected;
}
