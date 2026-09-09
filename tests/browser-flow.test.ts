import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BookingFlow, readStay } from "../src/booking.js";
import { makeOffer } from "../src/rates.js";
import { collectRateRows, currentRateListComplete, extractRateRows } from "../src/rates-dom.js";
import { assertPageUsable, waitForResults } from "../src/page-state.js";
import { clearPendingConfirmations } from "../src/confirmation.js";
import { checkoutPage, currentRateListPage, ratePage, raw, stay, stayInputs } from "./fixtures/marriott.js";
import { closeBrowser, getRoomOptions, redeemPoints, recoverSession, searchHotels } from "../src/browser.js";

const { attempts } = vi.hoisted(() => ({ attempts: {} as Record<string, any> }));
vi.mock("../src/secure-store.js", () => ({
  loadBookingAttempts: () => structuredClone(attempts),
  saveBookingAttempt: (key: string, value: unknown) => { attempts[key] = structuredClone(value); },
  saveCookies: vi.fn(), loadCookies: vi.fn(), saveSessionInfo: vi.fn(), getCredentials: () => null,
  clearAuthData: vi.fn(),
}));

let browser: Browser;
let page: Page;
let html: string;
let navigations: number;
let flow: BookingFlow;
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.env.MARRIOTT_BROWSER_CHANNEL ? { channel: process.env.MARRIOTT_BROWSER_CHANNEL } : {}) }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  for (const key of ["MARRIOTT_SPECIAL_RATES", "MARRIOTT_GOVERNMENT_SCOPE", "MARRIOTT_CORPORATE_CODE"]) vi.stubEnv(key, undefined);
  for (const key of Object.keys(attempts)) delete attempts[key];
  clearPendingConfirmations();
  page = await browser.newPage();
  // Every browser request is fulfilled locally. No Marriott requests or bookings.
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
  html = checkoutPage(); navigations = 0;
  flow = new BookingFlow(async url => { navigations++; await page.goto(url); return page; });
});
afterEach(async () => { await closeBrowser(); await page?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("extracts each rate's own price and terms from a shared room card", async () => {
  html = ratePage([{ ...raw, ratePlanCode: "PREPAY", nightly: "USD 150.00", total: "USD 340.00", cancellationPolicy: "Non-refundable" }, raw]);
  await page.goto("https://www.marriott.com/reservation/availability.mi");
  const rates = await page.evaluate(extractRateRows);
  expect(rates).toHaveLength(2);
  const offers = rates.map(rate => makeOffer(rate, stay, "regular")!);
  expect(offers[0].refundability).toBe("nonrefundable");
  expect(offers[0].total?.minorUnits).toBe(34000);
  expect(offers[1].refundability).toBe("refundable");
  expect(offers[1].total?.minorUnits).toBe(43050);
});

it("expands and parses the current rate-list layout with tax-inclusive totals", async () => {
  html = currentRateListPage();
  await page.goto("https://www.marriott.com/reservation/rateListMenu.mi");
  expect(await currentRateListComplete(page)).toBe(false);
  const rows = await collectRateRows(page);
  expect(await currentRateListComplete(page)).toBe(true);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ code: "GENR", ratePlanCode: "GOVV", name: "King room", nightly: "USD 122", total: "USD 244", taxesIncluded: true, eligibility: "State government ID required" });
  expect(rows[1]).toMatchObject({ code: "GENR", ratePlanCode: "GOVA", nightly: "USD 123", total: "USD 246", cancellationPolicy: "Free cancellation before or on Jun 29, 2099", cancellationDeadline: "Jun 29, 2099", eligibility: "Federal government ID required", available: true, bookingUrl: "" });
  expect(await readStay(page)).toMatchObject(stay);
});

it("rejects current-layout identifiers when room and signed product links disagree", async () => {
  html = currentRateListPage().replace("roomPoolCode=genr", "roomPoolCode=xxxx");
  await page.goto("https://www.marriott.com/reservation/rateListMenu.mi");
  const rows = await collectRateRows(page);
  expect(rows.every(row => row.code === "" && row.ratePlanCode === "")).toBe(true);
});

it("rejects current-layout identifiers when product and displayed dates disagree", async () => {
  html = currentRateListPage().replace('name="fromDate" value="07/01/2099"', 'name="fromDate" value="08/01/2099"');
  await page.goto("https://www.marriott.com/reservation/rateListMenu.mi");
  const rows = await collectRateRows(page);
  expect(rows.every(row => row.code === "" && row.ratePlanCode === "")).toBe(true);
});

it("distinguishes bot challenges and HTTP failures from empty availability", async () => {
  html = "<body>Verify you are human</body>";
  await page.goto("https://www.marriott.com/search/findHotels.mi");
  await expect(assertPageUsable(page)).rejects.toMatchObject({ code: "BOT_CHALLENGE" });
  await expect(assertPageUsable(page, 403)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(assertPageUsable(page, 429)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  html = "<body>Access Denied</body>";
  await page.reload();
  await expect(assertPageUsable(page, 200)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  html = '<body><p data-testid="no-availability">No rooms for these dates</p></body>';
  await page.reload();
  expect(await waitForResults(page, '[data-testid="rate-card"]', '[data-testid="no-availability"]')).toBe("empty");
});

it("expands rate details without transferring another rate's refund policy", async () => {
  html = ratePage([{ ...raw, cancellationPolicy: "", depositPolicy: "", cancellationDeadline: "" }]);
  html = html.replace('</section>', `<button data-testid="rate-details" onclick="document.getElementById('details').style.display='block'">Rate Details</button></section>
    <div role="dialog" id="details" style="display:none"><p data-testid="cancellation-policy">Non-refundable deposit rate</p><button onclick="document.getElementById('details').style.display='none'">Close</button></div>`);
  await page.goto("https://www.marriott.com/reservation/availability.mi");
  const rows = await collectRateRows(page);
  expect(rows[0].cancellationPolicy).toBe("Non-refundable deposit rate");
  expect(await page.locator('[role="dialog"]').isVisible()).toBe(false);
});

async function connectFixtureBrowser(render: (url: URL) => string) {
  const context = await browser.newContext();
  const originalNewPage = context.newPage.bind(context);
  vi.spyOn(context, "newPage").mockImplementation(async () => {
    const p = await originalNewPage();
    await p.route("**/*", route => route.fulfill({ contentType: "text/html", body: render(new URL(route.request().url())) }));
    return p;
  });
  vi.spyOn(chromium, "launch").mockResolvedValue({ newContext: async () => context, close: async () => {}, isConnected: () => true } as any);
}

it("searches government and regular rates with identical occupancy and no recursive lock", async () => {
  const queries: URLSearchParams[] = [];
  await connectFixtureBrowser(url => {
    queries.push(url.searchParams);
    const gov = url.searchParams.get("clusterCode") === "gov";
    return ratePage([gov ? { ...raw, ratePlanCode: "GOV", ratePlanName: "Government", eligibility: "Federal government ID and official travel required", total: "USD 350.50" } : raw], { ...stay, rooms: 2, children: 1 });
  });
  const results = await getRoomOptions({ ...stay, rooms: 2, children: 1 });
  expect(results.governmentAvailability).toBe("available");
  expect(results.offers).toHaveLength(2);
  expect(queries.map(q => q.get("clusterCode"))).toEqual(["none", "gov"]);
  expect(queries.map(q => q.get("corporateCode"))).toEqual(["", ""]);
  for (const query of queries) expect(query.get("guestCounts[1].numChildren")).toBe("1");
  await expect(redeemPoints({})).rejects.toThrow("Select an offerId");
  expect(await recoverSession()).toHaveProperty("success", true);
});

it("returns federal offers from Marriott's current room-rate layout", async () => {
  await connectFixtureBrowser(() => currentRateListPage());
  const result = await getRoomOptions({ ...stay, specialRates: ["government"] });
  expect(result.offers).toHaveLength(1);
  expect(result.offers[0]).toMatchObject({
    code: "GENR", ratePlanCode: "GOVA", governmentCategory: "federal",
    cancellationPolicy: "Free cancellation before or on Jun 29, 2099",
    cancellationDeadline: "Jun 29, 2099", eligibility: "Federal government ID required",
    taxesIncluded: true, refundability: "unknown",
    nightly: { currency: "USD", minorUnits: 12300 }, total: { currency: "USD", minorUnits: 24600 },
  });
  expect(result.rateResults[0].unmatchedRateCount).toBe(1);
  expect(result.governmentAvailability).toBe("available");
  expect(result.coverage.complete).toBe(false);
});

it("keeps a government fallback unknown and discloses a truncated hotel search", async () => {
  await connectFixtureBrowser(url => {
    if (url.pathname.includes("findHotels")) return `<body>${stayInputs(stay)}
      <div class="property-card" data-marsha="NYCMQ"><button class="title-container">Hotel A</button><a href="/hotels/NYCMQ">Details</a></div>
      <div data-testid="property-card" data-property-id="BOSCO"><h2>Hotel B</h2><a href="/hotels/BOSCO">Details</a></div>
      <p data-testid="results-complete">End</p></body>`;
    // The website ignored GOV and returned a regular rate.
    return ratePage();
  });
  const result = await searchHotels({ ...stay, destination: "New York", maxResults: 1 });
  expect(result.count).toBe(1);
  expect(result.hotels[0].name).toBe("Hotel A");
  expect(result.coverage.complete).toBe(false);
  expect(result.hotels[0].governmentAvailability).toBe("unknown");
  expect(result.hotels[0].offers).toHaveLength(1);
});

it("rejects hotel search results when the website ignored the dates", async () => {
  await connectFixtureBrowser(() => `<body>${stayInputs({ ...stay, checkIn: "2099-08-01" })}
    <div class="property-card" data-marsha="NYCMQ"><button class="title-container">Hotel A</button></div></body>`);
  const result = await searchHotels({ ...stay, destination: "New York" });
  expect(result.count).toBe(0);
  expect(result.coverage.complete).toBe(false);
  expect(result.searches.every(s => s.error?.startsWith("UNVERIFIED_STAY"))).toBe(true);
});

it("does not return empty availability when hotel cards cannot be identified", async () => {
  await connectFixtureBrowser(() => `<body>${stayInputs(stay)}<div class="property-card">Unrecognized card</div></body>`);
  const result = await searchHotels({ ...stay, destination: "New York" });
  expect(result.count).toBe(0);
  expect(result.coverage.complete).toBe(false);
  expect(result.searches.every(s => s.error?.includes("Hotel cards were present"))).toBe(true);
});

function remember(rate = raw, s = stay) {
  const offer = makeOffer(rate, s, /Government/.test(rate.ratePlanName) ? "government" : "regular")!;
  flow.remember([offer]);
  return offer;
}

it("returns every selected category and each offer's own cancellation policy without choosing a winner", async () => {
  const queries: URLSearchParams[] = [];
  const fed = { ...raw, ratePlanCode: "FED", ratePlanName: "Govt/military Rate", eligibility: "Federal government ID required" };
  const stateRate = { ...fed, ratePlanCode: "STATE", eligibility: "State government ID required" };
  await connectFixtureBrowser(url => {
    const q = url.searchParams;
    queries.push(q);
    const cluster = q.get("clusterCode")!;
    const rates = cluster === "gov" ? [stateRate, fed]
      : cluster === "aaa" ? [{ ...raw, ratePlanCode: "AAA", ratePlanName: "AAA Discount", eligibility: "AAA card required", cancellationPolicy: "Non-refundable" }]
      : cluster === "S9R" ? [{ ...raw, ratePlanCode: "SENIOR", ratePlanName: "Senior Discount", eligibility: "Age 62 or older", cancellationPolicy: "", cancellationDeadline: "" }]
      : cluster === "corp" ? [{ ...raw, ratePlanCode: "CORP", ratePlanName: "Corporate negotiated rate", eligibility: "Company ID required" }]
      : [raw, { ...raw, ratePlanCode: "PREPAY", cancellationPolicy: "Non-refundable", total: "USD 100.00" }];
    return ratePage(rates).replace("<body>", `<body><input type="hidden" name="clusterCode" value="${cluster}"><input name="corporateCode" value="${q.get("corporateCode")}">`);
  });
  const result = await getRoomOptions({ ...stay, specialRates: ["regular", "aaa_caa", "senior", "government", "corporate_promo"], corporateCode: "ABC" });
  expect(queries.map(q => q.get("clusterCode"))).toEqual(["none", "aaa", "S9R", "gov", "corp"]);
  expect(result.rateResults).toHaveLength(5);
  expect(result.offers).toHaveLength(6);
  expect(result.rateResults.every(r => r.availability === "available")).toBe(true);
  expect(result.rateResults[0].offers).toHaveLength(2);
  expect(result.rateResults[1].offers[0].cancellationPolicy).toBe("Non-refundable");
  expect(result.rateResults[2].offers[0].refundability).toBe("unknown");
  expect(result.rateResults[3].offers.map(o => o.governmentCategory)).toEqual(["federal"]);
  expect(result.rateResults[3].unmatchedRateCount).toBe(1);
  expect(result).not.toHaveProperty("comparisons");
  expect(result).not.toHaveProperty("selectedOffer");
  expect(result.governmentAvailability).toBe("available");
});

it("preserves other selected categories when one category's stay cannot be verified", async () => {
  await connectFixtureBrowser(url => ratePage([raw], url.searchParams.get("clusterCode") === "gov" ? { ...stay, checkIn: "2099-08-01" } : stay));
  const result = await getRoomOptions({ ...stay, specialRates: ["government", "regular"] });
  expect(result.rateResults[0].availability).toBe("unknown");
  expect(result.rateResults[0].error).toContain("UNVERIFIED_STAY");
  expect(result.rateResults[1].offers).toHaveLength(1);
  expect(result.coverage.complete).toBe(false);
});

it("does not report a state-only result as federal availability", async () => {
  await connectFixtureBrowser(() => ratePage([{ ...raw, ratePlanName: "Government State Rate", eligibility: "State government ID required" }]));
  const result = await getRoomOptions({ ...stay, specialRates: ["government"] });
  expect(result.offers).toEqual([]);
  expect(result.governmentAvailability).toBe("unknown");
  expect(result.rateResults[0].unmatchedRateCount).toBe(1);
});

it("requires explicit eligibility approval for non-government special rates", async () => {
  const aaa = { ...raw, ratePlanName: "AAA Discount", eligibility: "AAA membership card required" };
  const offer = makeOffer(aaa, stay, "aaa_caa")!;
  flow.remember([offer]);
  await expect(flow.checkout({ offerId: offer.offerId })).rejects.toThrow("specialRateEligibilityConfirmed");
  expect(navigations).toBe(0);
});

it("stops all category requests on an access denial", async () => {
  const queries: string[] = [];
  await connectFixtureBrowser(url => { queries.push(url.href); return "<body>Access Denied</body>"; });
  await expect(getRoomOptions({ ...stay, specialRates: ["government", "regular"] })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(queries).toHaveLength(1);
});

it("requires a verified category filter before reporting explicit no availability", async () => {
  let verified = false;
  await connectFixtureBrowser(() => `<body>${stayInputs(stay)}
    <input type="hidden" name="clusterCode" value="${verified ? "gov" : "none"}">
    <p data-testid="no-availability">No availability</p></body>`);
  const unknown = await getRoomOptions({ ...stay, specialRates: ["government"] });
  expect(unknown.governmentAvailability).toBe("unknown");
  verified = true;
  const unavailable = await getRoomOptions({ ...stay, specialRates: ["government"] });
  expect(unavailable.governmentAvailability).toBe("unavailable");
});

describe("checkout", () => {
  it("selects the exact rate when a booking link first opens a rate list", async () => {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: new URL(route.request().url()).pathname.endsWith("checkout.mi") ? checkoutPage() : ratePage() }));
    const offer = remember({ ...raw, bookingUrl: "" });
    const preview = await flow.checkout({ offerId: offer.offerId });
    expect(preview).toHaveProperty("requiresConfirmation", true);
    expect(page.url()).toContain("checkout.mi");
    expect(await page.evaluate(() => (window as any).submitted || 0)).toBe(0);
  });

  it("uses locked guest/offer data for token-only confirmation and verifies SPA success", async () => {
    const offer = remember();
    const preview = await flow.checkout({ offerId: offer.offerId, firstName: "Jane", email: "jane@example.com" });
    expect(preview).toHaveProperty("requiresConfirmation", true);
    expect(await page.evaluate(() => (window as any).submitted || 0)).toBe(0);
    const result = await flow.checkout({ confirmationToken: (preview as any).confirmationToken });
    expect(result).toMatchObject({ success: true, outcome: "confirmed", confirmationNumber: "ABC123456" });
    expect(await page.locator('[name="firstName"]').inputValue()).toBe("Jane");
    expect(await page.evaluate(() => (window as any).submitted)).toBe(1);
    expect(Object.values(attempts)[0].status).toBe("confirmed");
  });

  it("rejects token reuse and changed dates or guests before navigation", async () => {
    const offer = remember();
    const preview = await flow.checkout({ offerId: offer.offerId, firstName: "Jane" });
    await expect(flow.checkout({ confirmationToken: (preview as any).confirmationToken, checkIn: "2099-08-01" })).rejects.toThrow("parameters changed");
    expect(navigations).toBe(1);
    await expect(flow.checkout({ confirmationToken: (preview as any).confirmationToken })).rejects.toThrow("Invalid or expired");
  });

  it("requires a new preview on a price change, without clicking", async () => {
    const offer = remember();
    const preview = await flow.checkout({ offerId: offer.offerId });
    html = checkoutPage({ ...raw, total: "USD 450.50" });
    const changed = await flow.checkout({ confirmationToken: (preview as any).confirmationToken });
    expect(changed).toHaveProperty("requiresConfirmation", true);
    expect((changed as any).preview.offer.total.minorUnits).toBe(45050);
    expect(await page.evaluate(() => (window as any).submitted || 0)).toBe(0);
  });

  it("does not let a later room selection change an approved offer", async () => {
    const offer = remember();
    const preview = await flow.checkout({ offerId: offer.offerId });
    const other = remember({ ...raw, ratePlanCode: "OTHER" });
    flow.select({ offerId: other.offerId });
    expect(await flow.checkout({ confirmationToken: (preview as any).confirmationToken })).toMatchObject({ success: true, outcome: "confirmed" });
  });

  it("does not treat a generic form submit as a booking control", async () => {
    const offer = remember();
    html = checkoutPage().replace('data-testid="complete-booking"', 'type="submit"');
    const preview = await flow.checkout({ offerId: offer.offerId });
    await expect(flow.checkout({ confirmationToken: (preview as any).confirmationToken })).rejects.toThrow("Complete Booking button");
    expect(Object.keys(attempts)).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).submitted || 0)).toBe(0);
  });

  it("rejects checkout with the wrong stay and refuses unverified government eligibility", async () => {
    const offer = remember();
    html = checkoutPage(raw, { ...stay, rooms: 2 });
    await expect(flow.checkout({ offerId: offer.offerId })).rejects.toThrow("rooms");
    const gov = remember({ ...raw, ratePlanName: "Government", eligibility: "Official travel and government ID required" });
    await expect(flow.checkout({ offerId: gov.offerId })).rejects.toThrow("governmentEligibilityConfirmed");
  });

  it("preserves award mode and points through confirmation", async () => {
    const award = { ...raw, ratePlanCode: "AWARD", ratePlanName: "Points", points: "50,000 points", total: "USD 0.00" };
    const awardStay = { ...stay, usePoints: true };
    const offer = remember(award, awardStay);
    html = checkoutPage(award, awardStay);
    const preview = await flow.checkout({ offerId: offer.offerId }, "redeem_points", true);
    const result = await flow.checkout({ confirmationToken: (preview as any).confirmationToken }, "redeem_points", true);
    expect(result).toMatchObject({ success: true, pointsUsed: 50000 });
  });

  it("records an unknown submission and blocks retries even in a new flow instance", async () => {
    const offer = remember();
    html = checkoutPage(raw, stay, false);
    const preview = await flow.checkout({ offerId: offer.offerId });
    // Simulate a lost outcome response without waiting for the real 20-second timeout.
    const originalLocator = page.locator.bind(page);
    vi.spyOn(page, "locator").mockImplementation((selector: string, options?: any) => {
      if (selector.startsWith('[data-testid="confirmation-number"]')) return { count: async () => 0, first: () => ({ waitFor: async () => { throw new Error("Connection lost"); } }) } as any;
      return originalLocator(selector, options);
    });
    const result = await flow.checkout({ confirmationToken: (preview as any).confirmationToken });
    expect(result).toMatchObject({ success: false, outcome: "unknown" });
    const second = new BookingFlow(async () => { throw new Error("Must not navigate"); });
    second.remember([offer]);
    expect(await second.checkout({ offerId: offer.offerId })).toMatchObject({ outcome: "unknown" });
    expect(await page.evaluate(() => (window as any).submitted)).toBe(1);
  });
});
