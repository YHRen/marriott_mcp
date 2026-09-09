import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { createConfirmationToken, validateConfirmationToken } from "./confirmation.js";
import { loadBookingAttempts, saveBookingAttempt } from "./secure-store.js";
import { assertBookable, makeOffer, offerFingerprint, staySearchParams, type Offer, type Stay, type RawRate } from "./rates.js";
import { assertPageUsable } from "./page-state.js";

export interface CheckoutRequest {
  offerId?: string;
  hotelId?: string;
  roomCode?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
  governmentEligibilityConfirmed?: boolean;
  specialRateEligibilityConfirmed?: boolean;
  confirmationToken?: string;
}

/** Reads explicit server-rendered/form stay values, never substitutes the requested URL. */
export async function readStay(page: Page): Promise<Stay & { code: string; ratePlanCode: string }> {
  return page.evaluate(() => {
    const value = (name: string) => {
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input, select")).find(el => el.name === name && el.value);
      const result = input?.value || document.querySelector(`[data-field="${name}"]`)?.getAttribute("data-value") || "";
      if (name === "fromDate" || name === "toDate") {
        const date = result.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return date ? `${date[3]}-${date[1]}-${date[2]}` : result;
      }
      return result;
    };
    const count = (name: string) => value(name) === "" ? NaN : Number(value(name));
    const roomLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="ersViewRoomPool.mi"][href*="marshaCode="]'));
    const hotelIds = [...new Set(roomLinks.map(link => new URL(link.href, location.href).searchParams.get("marshaCode")?.toUpperCase()).filter(Boolean))];
    const hotelId = value("propertyCode") || (hotelIds.length === 1 ? hotelIds[0]! : "");
    const rooms = Number.isInteger(count("numberOfRooms")) ? count("numberOfRooms") : count("roomCount");
    const guestAdults = count("guestCounts[0].numAdults");
    const guestChildren = count("guestCounts[0].numChildren");
    const adults = Number.isInteger(guestAdults) ? guestAdults : count("numAdultsPerRoom");
    const children = Number.isInteger(guestChildren) ? guestChildren : count("childrenCount");
    const hasGuestCounts = Number.isInteger(guestAdults) && Number.isInteger(guestChildren);
    const consistent = Number.isInteger(rooms) && rooms > 0 && Number.isInteger(adults) && adults > 0 && Number.isInteger(children) && children >= 0
      && (!hasGuestCounts || Array.from({ length: rooms }, (_, i) =>
        count(`guestCounts[${i}].numAdults`) === adults && count(`guestCounts[${i}].numChildren`) === children
      ).every(Boolean));
    const redemptionFlags = [...new Set(Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="ersViewRateRules.mi"]'))
      .map(link => new URL(link.href, location.href).searchParams.get("redemptionflag") || ""))];
    const usePoints = value("redeemPoints") ? value("redeemPoints") === "true"
      : redemptionFlags.length === 1 ? /^(?:true|y|yes|1)$/i.test(redemptionFlags[0]) : false;
    return {
      hotelId, checkIn: value("fromDate"), checkOut: value("toDate"),
      adults: consistent ? adults : NaN, children: consistent ? children : NaN,
      rooms, usePoints,
      code: value("roomTypeCode"), ratePlanCode: value("ratePlanCode"),
    };
  });
}

export async function verifyStay(page: Page, stay: Stay): Promise<void> {
  const actual = await readStay(page);
  for (const key of ["hotelId", "checkIn", "checkOut", "adults", "children", "rooms", "usePoints"] as const) {
    if (actual[key] !== stay[key]) throw new Error(`UNVERIFIED_STAY: Marriott's ${key} does not match the requested stay. No booking was submitted.`);
  }
}

async function checkoutQuote(page: Page, offer: Offer): Promise<Offer> {
  await assertPageUsable(page);
  await verifyStay(page, offer);
  const actual = await readStay(page);
  if (actual.code !== offer.code || actual.ratePlanCode !== offer.ratePlanCode) throw new Error("OFFER_CHANGED: The checkout room or rate plan differs. Request a new preview.");
  const raw = await page.evaluate((): RawRate | null => {
    const summaries = document.querySelectorAll('[data-testid="booking-summary"], .booking-summary');
    if (summaries.length !== 1) return null;
    const summary = summaries[0];
    const text = (s: string) => summary.querySelector(s)?.textContent?.trim() || "";
    return {
      code: "", name: "", ratePlanCode: "", ratePlanName: text('[data-testid="rate-name"], .rate-plan-name'),
      nightly: "", total: text('[data-testid="total-price"], [data-testid="stay-total"], .total-price'),
      currency: summary.getAttribute("data-currency") || "",
      taxesIncluded: summary.getAttribute("data-taxes-included") === "true" || /(?:includes|including) (?:all )?taxes (?:and|&) (?:all )?fees/i.test(text('[data-testid="taxes-fees"], .taxes-fees')),
      cancellationPolicy: text('[data-testid="cancellation-policy"], .cancellation-policy'),
      cancellationDeadline: summary.querySelector('[data-testid="cancellation-deadline"], .cancellation-deadline')?.getAttribute("datetime") || text('[data-testid="cancellation-deadline"], .cancellation-deadline'),
      depositPolicy: text('[data-testid="deposit-policy"], .deposit-policy'),
      eligibility: text('[data-testid="rate-eligibility"], .rate-eligibility'),
      available: true, bookingUrl: location.href, points: text('[data-testid="total-points"], .total-points'),
    };
  });
  if (!raw) throw new Error("UNVERIFIED_OFFER: A unique checkout summary was not found.");
  const fresh = makeOffer({ ...raw, code: actual.code, ratePlanCode: actual.ratePlanCode }, offer, offer.requestedSelection, true);
  if (!fresh) throw new Error("UNVERIFIED_OFFER: Checkout rate could not be verified.");
  assertBookable(fresh);
  return fresh;
}

export class BookingFlow {
  private offers = new Map<string, Offer>();
  private selected?: string;

  constructor(private navigate: (url: string) => Promise<Page>) {}

  reset(): void { this.offers.clear(); this.selected = undefined; }

  remember(offers: Offer[]): void {
    for (const [id, offer] of this.offers) {
      if (Date.now() - Date.parse(offer.observedAt) > 15 * 60_000) this.offers.delete(id);
    }
    for (const offer of offers) this.offers.set(offer.offerId, structuredClone(offer));
  }

  select(params: { offerId?: string; hotelId?: string; roomCode?: string; ratePlanCode?: string }) {
    const candidates = params.offerId ? [this.offers.get(params.offerId)].filter((o): o is Offer => Boolean(o)) : [...this.offers.values()].filter(o => o.hotelId === params.hotelId && o.code === params.roomCode && o.ratePlanCode === params.ratePlanCode);
    if (candidates.length !== 1) throw new Error("Select a unique offerId from get_room_options or search_hotels.");
    const offer = candidates[0];
    for (const [input, key] of [["hotelId", "hotelId"], ["roomCode", "code"], ["ratePlanCode", "ratePlanCode"]] as const) {
      if (params[input] !== undefined && params[input] !== offer[key]) throw new Error("Selection parameters do not match the offer.");
    }
    assertBookable(offer);
    this.selected = offer.offerId;
    return { success: true, offer: structuredClone(offer), nextStep: "Call checkout for a verified preview." };
  }

  async checkout(request: CheckoutRequest, action = "checkout", pointsOnly = false) {
    let offer: Offer;
    let locked: CheckoutRequest;
    if (request.confirmationToken) {
      const saved = validateConfirmationToken(request.confirmationToken, action) as { offer: Offer; request: CheckoutRequest };
      offer = saved.offer;
      locked = saved.request;
      for (const [key, value] of Object.entries(request)) {
        if (key !== "confirmationToken" && value !== undefined && value !== locked[key as keyof CheckoutRequest]) throw new Error("Confirmation parameters changed. Request a new preview.");
      }
    } else {
      const cached = this.offers.get(request.offerId || this.selected || "");
      if (!cached) throw new Error("Select an offerId from current search results before checkout.");
      offer = structuredClone(cached);
      locked = { ...request, offerId: offer.offerId, hotelId: offer.hotelId, roomCode: offer.code, checkIn: offer.checkIn, checkOut: offer.checkOut, adults: offer.adults, children: offer.children, rooms: offer.rooms };
      for (const key of ["hotelId", "roomCode", "checkIn", "checkOut", "adults", "children", "rooms"] as const) {
        if (request[key] !== undefined && request[key] !== locked[key]) throw new Error("Checkout parameters do not match the selected offer. Search again for the requested stay.");
      }
    }
    assertBookable(offer);
    if (Date.now() - Date.parse(offer.observedAt) > 15 * 60_000) throw new Error("Offer expired. Search again before booking.");
    if (pointsOnly && !offer.usePoints) throw new Error("Select an offer from a usePoints search to redeem points.");
    if (offer.rateType === "government" && !locked.governmentEligibilityConfirmed) throw new Error("Review the offer's eligibility terms and set governmentEligibilityConfirmed only when the traveler qualifies.");
    if (!["regular", "government"].includes(offer.rateType) && !locked.specialRateEligibilityConfirmed) throw new Error("Review the special-rate eligibility terms and set specialRateEligibilityConfirmed only when the traveler qualifies.");

    // Excludes rate/price so a changed offer cannot bypass a pending submission.
    const attemptKey = createHash("sha256").update(JSON.stringify([offer.hotelId, offer.checkIn, offer.checkOut, offer.adults, offer.children, offer.rooms])).digest("hex");
    const previous = loadBookingAttempts()[attemptKey];
    if (previous) return { success: previous.status === "confirmed", outcome: previous.status, confirmationNumber: previous.confirmationNumber, message: "A submission for this stay already exists. Check get_reservation or Marriott before making another booking; it was not resubmitted." };

    const query = staySearchParams(offer, offer.requestedSelection);
    query.set("roomTypeCode", offer.code);
    query.set("ratePlanCode", offer.ratePlanCode);
    // Exact rate link when available; quote verification below rejects changed context.
    const page = await this.navigate(offer.bookingUrl || `https://www.marriott.com/reservation/rateListMenu.mi?${query}`);
    await page.locator('[data-testid="booking-summary"], .booking-summary, [data-testid="rate-card"], .rate-plan-card').first().waitFor({ state: "visible", timeout: 15000 });
    if (!await page.locator('[data-testid="booking-summary"], .booking-summary').count()) {
      // Some Marriott links lead to a rate list, rather than directly to checkout.
      // Only select the exact room/rate; never click a generic submit button here.
      await assertPageUsable(page);
      await verifyStay(page, offer);
      const card = page.locator(`[data-room-type-code="${offer.code}"], [data-room-code="${offer.code}"]`)
        .locator(`[data-rate-plan-code="${offer.ratePlanCode}"]`);
      const select = card.locator('[data-testid="select-rate"], button[name="selectRate"]');
      if (await select.count() !== 1 || !await select.isEnabled()) throw new Error("UNVERIFIED_OFFER: Exact rate selection control was not found.");
      await select.click();
    }
    await page.locator('[data-testid="booking-summary"], .booking-summary').first().waitFor({ state: "visible", timeout: 15000 });
    let fresh = await checkoutQuote(page, offer);
    if (offer.refundability === "refundable" && fresh.refundability !== "refundable") {
      throw new Error("OFFER_CHANGED: Free cancellation is no longer verified. Search for a new refundable offer.");
    }
    if (offerFingerprint(fresh) !== offerFingerprint(offer)) {
      // The new quote is returned for review, never charged under an old token.
      offer = { ...fresh, offerId: offer.offerId };
      this.remember([offer]);
      const token = createConfirmationToken(action, { offer, request: locked });
      return { success: true, requiresConfirmation: true, confirmationToken: token, preview: { offer, guest: locked }, message: "Price or terms changed. Review this new quote and confirm again." };
    }
    if (!request.confirmationToken) {
      for (const name of ["firstName", "lastName", "email", "phone"] as const) {
        const field = page.locator(`input[name="${name}"]`);
        if (locked[name] === undefined && await field.count() === 1) locked[name] = await field.inputValue();
      }
      const token = createConfirmationToken(action, { offer, request: locked });
      return { success: true, requiresConfirmation: true, confirmationToken: token, preview: { offer, guest: locked }, message: "Review the total, cancellation terms and guest details. Submit the token only after explicit user approval. Expires in five minutes." };
    }

    for (const name of ["firstName", "lastName", "email", "phone", "specialRequests"] as const) {
      if (locked[name] !== undefined) {
        const field = page.locator(`input[name="${name}"], textarea[name="${name}"]`);
        if (await field.count() !== 1) throw new Error(`Guest field ${name} could not be verified. No booking was submitted.`);
        await field.fill(locked[name]!);
        if (await field.inputValue() !== locked[name]) throw new Error(`Guest field ${name} changed. No booking was submitted.`);
      }
    }
    fresh = await checkoutQuote(page, offer);
    if (offerFingerprint(fresh) !== offerFingerprint(offer)) throw new Error("OFFER_CHANGED: Quote changed while preparing checkout. Request a new preview.");
    const submit = page.locator('[data-testid="complete-booking"], button[name="completeBooking"]');
    if (await submit.count() !== 1 || !await submit.isEnabled()) throw new Error("A unique, enabled Complete Booking button was not found. No booking was submitted.");
    if (await page.locator('[data-testid="confirmation-number"], .l-confirmation-number, .confirmation-number').count()) throw new Error("Checkout already contains a confirmation. Reconcile this reservation before submitting.");
    // Write before clicking: crashes and click timeouts must not cause a retry.
    saveBookingAttempt(attemptKey, { status: "unknown", createdAt: new Date().toISOString() });
    try {
      await submit.click();
      // Wait for a durable outcome element: supports navigation and SPA updates.
      const confirmation = page.locator('[data-testid="confirmation-number"], .l-confirmation-number, .confirmation-number');
      await confirmation.first().waitFor({ state: "visible", timeout: 20000 });
      await assertPageUsable(page);
      await verifyStay(page, offer);
      const confirmedStay = await readStay(page);
      if (confirmedStay.code !== offer.code || confirmedStay.ratePlanCode !== offer.ratePlanCode) throw new Error("Confirmation does not match the approved offer");
      const raw = (await confirmation.first().innerText()).trim();
      const number = raw.replace(/^confirmation\s*(?:number|#|:)\s*:?\s*/i, "").trim();
      if (!/^[A-Za-z0-9]{4,20}$/.test(number)) throw new Error("Unrecognized confirmation number");
      saveBookingAttempt(attemptKey, { status: "confirmed", confirmationNumber: number, createdAt: new Date().toISOString() });
      this.selected = undefined;
      return { success: true, outcome: "confirmed", confirmationNumber: number, message: "Booking confirmed.", pointsUsed: offer.usePoints ? offer.pointsRequired : undefined };
    } catch {
      return { success: false, outcome: "unknown", message: "Submission outcome is unknown. Do not retry booking. Check get_reservation, Marriott, or your confirmation email. This stay is blocked from automatic resubmission." };
    }
  }
}
