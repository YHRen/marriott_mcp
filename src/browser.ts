/**
 * Strider Labs - Marriott Browser Automation
 *
 * Playwright-based browser automation for Marriott hotel booking operations.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import {
  saveCookies,
  loadCookies,
  saveSessionInfo,
  getCredentials,
  clearAuthData,
  type SessionInfo,
} from "./secure-store.js";
import { BrowserMutex, withMutex } from "./mutex.js";
import { clearPendingConfirmations } from "./confirmation.js";
import { BookingFlow, readStay, verifyStay, type CheckoutRequest } from "./booking.js";
import { makeOffer, offerFingerprint, staySearchParams, type Offer, type Stay } from "./rates.js";
import { resolveRateSelections, type RateOptions, type RateSelection } from "./rate-options.js";
import { collectRateRows, currentRateListComplete, prepareRateList, RATE_RESULTS, RATE_ROWS, NO_ROOMS } from "./rates-dom.js";
import { assertPageUsable, waitForResults, MarriottPageError } from "./page-state.js";
import { attachChrome } from "./cdp.js";

const MARRIOTT_BASE_URL = "https://www.marriott.com";
const DEFAULT_TIMEOUT = 30000;

// Singleton browser instance
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let attachedToUserChrome = false;

/** Mutex to serialize all browser operations */
const browserMutex = new BrowserMutex();

/**
 * Validate that a URL is on marriott.com before navigating.
 * Prevents SSRF and open redirect attacks from malicious tool inputs.
 */
function assertMarriottUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS URLs are allowed");
    }
    if (
      parsed.hostname !== "www.marriott.com" &&
      parsed.hostname !== "marriott.com" &&
      !parsed.hostname.endsWith(".marriott.com")
    ) {
      throw new Error(
        `Navigation blocked: ${parsed.hostname} is not on marriott.com`
      );
    }
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error("Invalid URL format");
    }
    throw e;
  }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface HotelResult {
  id: string;
  name: string;
  brand?: string;
  url?: string;
  starRating?: number;
  guestRating?: string;
  reviewCount?: number;
  location?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  pricePerNight?: string;
  totalPrice?: string;
  imageUrl?: string;
  freeCancellation?: boolean;
  bonvoyBonus?: boolean;
  distanceFromCenter?: string;
}

export interface HotelDetails extends HotelResult {
  description?: string;
  amenities?: string[];
  roomTypes?: RoomOption[];
  checkInTime?: string;
  checkOutTime?: string;
  policies?: string[];
  phone?: string;
  lat?: number;
  lng?: number;
  nearbyAttractions?: string[];
  parkingInfo?: string;
  petPolicy?: string;
}

export type RoomOption = Offer;

export interface Extra {
  type: "parking" | "breakfast" | "late_checkout" | "early_checkin" | "airport_transfer" | "spa_credit";
  name: string;
  description?: string;
  price?: string;
  selected?: boolean;
}

export interface Reservation {
  confirmationNumber: string;
  status: string;
  hotelName: string;
  hotelAddress?: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  guests?: number;
  totalPrice?: string;
  cancellationPolicy?: string;
  bonvoyPointsEarned?: number;
  extras?: Extra[];
  guestName?: string;
}

export interface BonvoyStatus {
  memberNumber?: string;
  memberName?: string;
  tier?: string;
  points?: number;
  nightsThisYear?: number;
  nightsToNextTier?: number;
  nextTier?: string;
  expirationDate?: string;
  recentActivity?: Array<{
    date: string;
    description: string;
    points: number;
  }>;
}

export interface StayHistory {
  stays: Array<{
    confirmationNumber: string;
    hotelName: string;
    location?: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    roomType?: string;
    pointsEarned?: number;
    totalCost?: string;
    status: string;
  }>;
  totalStays: number;
  totalNights: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function randomDelay(min = 500, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Browser Lifecycle ────────────────────────────────────────────────────────

async function initBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  if (browser && context && page && browser.isConnected() && !page.isClosed()) {
    return { browser, context, page };
  }
  if (browser || context || page) await closeBrowserInternal();

  if (process.env.MARRIOTT_CDP_URL) {
    const attached = await attachChrome(process.env.MARRIOTT_CDP_URL);
    browser = attached.browser;
    context = attached.context;
    page = attached.page;
    attachedToUserChrome = true;
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    // Preserve Chrome's existing consent, storage, cache, and browser settings.
    // Explicit navigation URLs are still validated by the operations below.
    return attached;
  }

  browser = await chromium.launch({
    headless: process.env.MARRIOTT_HEADLESS === "true",
    chromiumSandbox: process.env.MARRIOTT_NO_SANDBOX !== "true",
    ...(process.env.MARRIOTT_BROWSER_CHANNEL ? { channel: process.env.MARRIOTT_BROWSER_CHANNEL } : {}),
    args: [
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      // Only disable sandbox if explicitly opted in (e.g., for Docker)
      ...(process.env.MARRIOTT_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"]
        : []),
    ],
  });

  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Keep navigation inside Marriott; third-party static resources may still load.
  await context.route("**/*", async route => {
    if (route.request().isNavigationRequest() && !route.request().frame().parentFrame()) {
      try { assertMarriottUrl(route.request().url()); } catch { await route.abort(); return; }
    }
    await route.continue();
  });

  // Load saved cookies if available
  await loadCookies(context);

  page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  return { browser, context, page };
}

export async function closeBrowser(): Promise<void> {
  return withMutex(browserMutex, closeBrowserInternal);
}

async function closeBrowserInternal(): Promise<void> {
  bookingFlow.reset();
  clearPendingConfirmations();
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  if (context) {
    if (!attachedToUserChrome) await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  attachedToUserChrome = false;
}

export async function logoutBrowser() {
  return withMutex(browserMutex, async () => {
    const detached = attachedToUserChrome || Boolean(process.env.MARRIOTT_CDP_URL);
    await closeBrowserInternal();
    clearAuthData();
    return { success: true, message: detached
      ? "MCP disconnected and its saved authentication was cleared. Chrome remains signed in; use Marriott's Sign Out in that profile to end the website session."
      : "Logged out. Session and cookies cleared." };
  });
}

async function persistCookies(ctx: BrowserContext): Promise<void> {
  if (!attachedToUserChrome) await saveCookies(ctx);
}

function persistSession(info: SessionInfo): void {
  if (!attachedToUserChrome) saveSessionInfo(info);
}

async function getPage(): Promise<Page> {
  const { page: p } = await initBrowser();
  return p;
}

async function navigate(url: string): Promise<Page> {
  assertMarriottUrl(url);
  const p = await getPage();
  const response = await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  assertMarriottUrl(p.url());
  await assertPageUsable(p, response?.status());
  if (context) await persistCookies(context);
  return p;
}

const bookingFlow = new BookingFlow(navigate);

export async function recoverSession() {
  return withMutex(browserMutex, async () => {
    if (!process.env.MARRIOTT_CDP_URL && process.env.MARRIOTT_HEADLESS === "true") throw new Error("Restart with MARRIOTT_HEADLESS=false to enable manual recovery in the server browser.");
    const p = await getPage();
    await p.bringToFront();
    return { success: true, message: "Complete verification in the open Marriott browser, then retry your search. Use status after signing in." };
  });
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

export async function checkLoginStatus(): Promise<SessionInfo> {
  return withMutex(browserMutex, async () => {
  const { context: ctx } = await initBrowser();
  const p = await getPage();

  try {
    const url = `${MARRIOTT_BASE_URL}/loyalty/myAccount/default.mi`;
    assertMarriottUrl(url);
    await p.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await randomDelay(500, 1000);

    // Check if redirected to login page
    assertMarriottUrl(p.url());
    const currentUrl = new URL(p.url());
    if (/\/(?:sign-?in|login|loyalty\/loginPage)(?:[/.]|$)/i.test(currentUrl.pathname)) {
      const info: SessionInfo = {
        isLoggedIn: false,
        lastUpdated: new Date().toISOString(),
      };
      persistSession(info);
      return info;
    }

    await assertPageUsable(p);

    // The current account page omits the legacy member selectors. Its Sign Out
    // link lives in a collapsed menu, so visibility is not an authentication test.
    // Require both the protected account route and account title as corroboration.
    const accountPage = currentUrl.pathname === "/loyalty/myAccount/default.mi"
      && /^my account$/i.test((await p.title()).trim());
    const hasSignOut = accountPage && await p.locator("a, button")
      .filter({ hasText: /^\s*sign out\s*$/i }).count() > 0;

    // Extract user info
    const userName = await p
      .$eval(
        '[data-testid="member-name"], .l-member-name, .js-memberName, [class*="memberName"]',
        (el) => el.textContent?.trim()
      )
      .catch(() => null);

    const bonvoyNumber = await p
      .$eval(
        '[data-testid="member-number"], .l-member-number, [class*="memberNumber"]',
        (el) => el.textContent?.trim()
      )
      .catch(() => null);

    const tier = await p
      .$eval(
        '[data-testid="member-tier"], .l-member-tier, [class*="memberTier"], [class*="tier"]',
        (el) => el.textContent?.trim()
      )
      .catch(() => null);

    const info: SessionInfo = {
      isLoggedIn: Boolean(userName && bonvoyNumber) || hasSignOut,
      userName: userName || undefined,
      bonvoyNumber: bonvoyNumber || undefined,
      bonvoyTier: tier || undefined,
      lastUpdated: new Date().toISOString(),
    };

    await persistCookies(ctx);
    persistSession(info);
    return info;
  } catch (error) {
    if (error instanceof MarriottPageError) throw error;
    return {
      isLoggedIn: false,
      lastUpdated: new Date().toISOString(),
    };
  }
});
}

export async function initiateLogin(): Promise<{
  message: string;
  loginUrl: string;
  instructions: string;
}> {
  return withMutex(browserMutex, async () => {
  const credentials = process.env.MARRIOTT_CDP_URL ? null : getCredentials();

  if (credentials) {
    return await performLogin(credentials.email, credentials.password);
  }

  if (!process.env.MARRIOTT_CDP_URL && process.env.MARRIOTT_HEADLESS === "true") throw new Error("Manual login requires MARRIOTT_HEADLESS=false. Restart the server with that setting.");
  const p = await getPage();
  await p.goto(`${MARRIOTT_BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await p.bringToFront();
  return {
    message: "Manual login required in the opened server browser",
    loginUrl: `${MARRIOTT_BASE_URL}/loyalty/loginPage.mi`,
    instructions:
      "Make your privacy choices and sign in from Marriott's homepage in this browser. Then call status. Attached Chrome profiles retain their own session; the MCP does not export their cookies.",
  };
});
}

async function performLogin(
  email: string,
  password: string
): Promise<{ message: string; loginUrl: string; instructions: string }> {
  const { context: ctx } = await initBrowser();
  const p = await getPage();

  try {
    const url = `${MARRIOTT_BASE_URL}/loyalty/loginPage.mi`;
    assertMarriottUrl(url);
    await p.goto(url, {
      waitUntil: "domcontentloaded",
    });
    await randomDelay(1000, 2000);

    // Fill email
    const emailField = await p.waitForSelector(
      'input[name="email"], input[type="email"], #email, #username',
      { timeout: 10000 }
    );
    await emailField.click();
    await emailField.fill(email);
    await randomDelay(300, 700);

    // Fill password
    const passwordField = await p.waitForSelector(
      'input[name="password"], input[type="password"], #password',
      { timeout: 10000 }
    );
    await passwordField.click();
    await passwordField.fill(password);
    await randomDelay(300, 700);

    // Submit
    const submitButton = await p.waitForSelector(
      'button[type="submit"], input[type="submit"], .l-signin-btn, [data-testid="signin-submit"]',
      { timeout: 10000 }
    );
    await submitButton.click();

    await p.locator('[data-testid="member-number"], .l-member-number, [class*="memberNumber"]').first().waitFor({ state: "visible", timeout: 15000 });
    await assertPageUsable(p);

    const currentUrl = p.url();
    if (currentUrl.includes("signin") || currentUrl.includes("login")) {
      throw new Error("Login failed. Please check credentials or try manual login.");
    }

    await persistCookies(ctx);

    return {
      message: "Login successful",
      loginUrl: `${MARRIOTT_BASE_URL}/loyalty/loginPage.mi`,
      instructions: "Successfully logged in. Use status to verify.",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      message: `Login attempt: ${msg}`,
      loginUrl: `${MARRIOTT_BASE_URL}/loyalty/loginPage.mi`,
      instructions:
        "Automatic login encountered an issue. Use recover_session and finish signing in in the server browser, then use status.",
    };
  }
}

// ─── Hotel Search ──────────────────────────────────────────────────────────────

export interface RoomSearchParams extends RateOptions {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
  usePoints?: boolean;
}

export interface RateResult {
  selection: RateSelection;
  availability: "available" | "unavailable" | "unknown";
  offers: Offer[];
  unmatchedRateCount: number;
  coverage: { complete: boolean; note: string };
  error?: string;
}

export interface RoomSearchResult {
  offers: Offer[];
  rateResults: RateResult[];
  decisionRequired: true;
  governmentAvailability: "available" | "unavailable" | "unknown" | "not_requested";
  coverage: { complete: boolean; note: string };
}

export async function searchHotels(params: RateOptions & {
  destination: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
  maxResults?: number;
  maxPages?: number;
}) {
  return withMutex(browserMutex, async () => {
    const selections = resolveRateSelections(params);
    const hotels = new Map<string, HotelResult>();
    const searches: { selection: RateSelection; complete: boolean; error?: string }[] = [];
    let complete = true;
    const maxResults = params.maxResults ?? 10;
    const maxPages = params.maxPages ?? 5;
    for (const selection of selections) {
      try {
      const query = staySearchParams({ ...params, adults: params.adults ?? 1, children: params.children ?? 0, rooms: params.rooms ?? 1, usePoints: false }, selection);
      query.set("destinationAddress.destination", params.destination);
      const p = await navigate(`${MARRIOTT_BASE_URL}/search/findHotels.mi?${query}`);
      let exhausted = false;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const state = await waitForResults(p, '[data-testid="property-card"], .property-card, .l-property-card', '[data-testid="no-results"], .no-results');
        const actual = await readStay(p);
        if (actual.checkIn !== params.checkIn || actual.checkOut !== params.checkOut) {
          throw new Error("UNVERIFIED_STAY: Marriott did not apply the requested search dates. Availability is unknown.");
        }
        if (state === "empty") { exhausted = true; break; }
        const found = await p.evaluate(() => {
          return Array.from(document.querySelectorAll('[data-testid="property-card"], .property-card, .l-property-card')).map(card => {
            const anchor = card.querySelector<HTMLAnchorElement>("a.view-rates-button-container[href]")
              || card.querySelector<HTMLAnchorElement>("a[href]");
            const url = anchor?.href || "";
            const id = card.getAttribute("data-property-id") || card.getAttribute("data-hotel-id") || card.getAttribute("data-marsha")
              || (url ? new URL(url).searchParams.get("propertyCode") : "")
              || url.match(/\/(?:travel|hotel-overview)\/([a-z0-9]{5})(?:-|[/.])/i)?.[1]
              || url.match(/\/hotels\/([a-z0-9]{5})-/i)?.[1] || "";
            return {
              id: id.toUpperCase(),
              name: card.querySelector('[data-testid="property-name"], .property-name, button.title-container, h2, h3')?.textContent?.trim() || "",
              url,
              location: card.querySelector('[data-testid="location"], .location, .address')?.textContent?.trim(),
              pricePerNight: card.querySelector('[data-testid="price"], .price')?.textContent?.trim(),
            };
          });
        });
        if (!found.some(hotel => /^[A-Z0-9]{2,10}$/.test(hotel.id) && hotel.name)) {
          throw new MarriottPageError("PAGE_CHANGED", "Hotel cards were present but no hotel identifiers and names could be verified. Availability is unknown.");
        }
        for (const hotel of found) {
          if (!/^[A-Z0-9]{2,10}$/.test(hotel.id) || !hotel.name) { complete = false; continue; }
          if (hotels.size < maxResults || hotels.has(hotel.id)) hotels.set(hotel.id, hotel);
          else complete = false;
        }
        const nextButton = p.locator('[data-testid="next-page"], a[rel="next"], button[aria-label="Next page"]').first();
        if (!await nextButton.count() || !await nextButton.isEnabled() || await nextButton.getAttribute("aria-disabled") === "true") {
          // Completeness needs positive end/count evidence, not merely a missing selector.
          exhausted = Boolean(await p.locator('[data-testid="results-complete"], [data-has-more="false"]').count())
            || Boolean(await nextButton.count());
          break;
        }
        if (hotels.size >= maxResults) break;
        const before = await p.locator('[data-testid="property-card"], .property-card, .l-property-card').allTextContents();
        await nextButton.click();
        await p.waitForFunction(previous => JSON.stringify(Array.from(document.querySelectorAll('[data-testid="property-card"], .property-card, .l-property-card')).map(el => el.textContent)) !== JSON.stringify(previous), before, { timeout: 15000 });
      }
      complete &&= exhausted;
      searches.push({ selection, complete: exhausted });
      } catch (error) {
        if (!isUnrecognizedRatePage(error)) throw error;
        complete = false;
        searches.push({ selection, complete: false, error: error.message });
      }
    }
    const results = [];
    for (const hotel of hotels.values()) {
      const rates = await getRoomOptionsInternal({ ...params, hotelId: hotel.id });
      results.push({ ...hotel, ...rates });
      complete &&= rates.coverage.complete;
    }
    return {
      hotels: results, count: results.length,
      searches,
      selectedRates: selections,
      decisionRequired: true,
      coverage: { complete, maxResults, maxPages, note: complete ? "All inspected offers are returned for user review; no rate was selected." : "Partial coverage: result limits, unrecognized pages or unexpanded rates may hide offers. Unknown is not unavailable." },
    };
  });
}

// ─── Hotel Details ─────────────────────────────────────────────────────────────

export async function getHotelDetails(hotelIdOrUrl: string): Promise<HotelDetails> {
  return withMutex(browserMutex, async () => {
  const p = await getPage();

  let url: string;
  if (hotelIdOrUrl.startsWith("http")) {
    url = hotelIdOrUrl;
  } else {
    url = `${MARRIOTT_BASE_URL}/hotels/hotel-overview/${hotelIdOrUrl}.mi`;
  }

  assertMarriottUrl(url);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  await randomDelay(1500, 3000);

  const details = await p.evaluate(() => {
    const name =
      document.querySelector('[data-testid="hotel-name"], h1, .l-property-name')
        ?.textContent?.trim() || "";

    const description =
      document.querySelector(
        '[data-testid="hotel-description"], .l-property-description, .hotel-description, [class*="description"]'
      )?.textContent?.trim() || undefined;

    const amenities: string[] = [];
    document
      .querySelectorAll(
        '[data-testid="amenity"], .l-amenity, [class*="amenity"], [class*="feature"]'
      )
      .forEach((el) => {
        const text = el.textContent?.trim();
        if (text) amenities.push(text);
      });

    const address =
      document.querySelector(
        '[data-testid="address"], .l-address, [class*="address"], [itemprop="streetAddress"]'
      )?.textContent?.trim() || undefined;

    const phone =
      document.querySelector('[data-testid="phone"], .l-phone, [itemprop="telephone"]')
        ?.textContent?.trim() || undefined;

    const checkInTime =
      document
        .querySelector('[class*="checkIn"], [data-testid="check-in-time"]')
        ?.textContent?.trim() || undefined;

    const checkOutTime =
      document
        .querySelector('[class*="checkOut"], [data-testid="check-out-time"]')
        ?.textContent?.trim() || undefined;

    const policies: string[] = [];
    document
      .querySelectorAll('[class*="policy"], [class*="Policy"]')
      .forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length < 500) policies.push(text);
      });

    const parkingInfo =
      document
        .querySelector('[class*="parking"], [data-testid="parking"]')
        ?.textContent?.trim() || undefined;

    const petPolicy =
      document
        .querySelector('[class*="pet"], [data-testid="pet-policy"]')
        ?.textContent?.trim() || undefined;

    // Extract lat/lng from page scripts
    let lat: number | undefined;
    let lng: number | undefined;
    const scripts = document.querySelectorAll("script");
    scripts.forEach((script) => {
      const content = script.textContent || "";
      const latMatch = content.match(/"latitude"\s*:\s*([-\d.]+)/);
      const lngMatch = content.match(/"longitude"\s*:\s*([-\d.]+)/);
      if (latMatch) lat = parseFloat(latMatch[1]);
      if (lngMatch) lng = parseFloat(lngMatch[1]);
    });

    const imgEl = document.querySelector(
      '[data-testid="hero-image"] img, .l-hero-image img, .property-hero img'
    );

    const starEl = document.querySelector(
      '[aria-label*="star"], [class*="starRating"], [data-testid="star-rating"]'
    );
    const starText = starEl?.getAttribute("aria-label") || starEl?.textContent || "";
    const starMatch = starText.match(/(\d+(?:\.\d+)?)/);

    return {
      name,
      description,
      amenities: amenities.slice(0, 30),
      address,
      phone,
      checkInTime,
      checkOutTime,
      policies: policies.slice(0, 10),
      parkingInfo,
      petPolicy,
      lat,
      lng,
      starRating: starMatch ? parseFloat(starMatch[1]) : undefined,
      imageUrl: imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || undefined,
    };
  });

  const id = hotelIdOrUrl.startsWith("http")
    ? hotelIdOrUrl.match(/\/([A-Z0-9]+)\.mi/)?.[1] || hotelIdOrUrl
    : hotelIdOrUrl;

  return {
    id,
    url: p.url(),
    ...details,
  };
});
}

// ─── Room Options ──────────────────────────────────────────────────────────────

export async function getRoomOptions(params: RoomSearchParams): Promise<RoomSearchResult> {
  return withMutex(browserMutex, () => getRoomOptionsInternal(params));
}

/** Caller owns browserMutex. Internal calls never acquire it recursively. */
async function getRoomOptionsInternal(params: RoomSearchParams): Promise<RoomSearchResult> {
  const stay: Stay = {
    hotelId: params.hotelId, checkIn: params.checkIn, checkOut: params.checkOut,
    adults: params.adults ?? 1, children: params.children ?? 0, rooms: params.rooms ?? 1,
    usePoints: params.usePoints ?? false,
  };
  const selections = resolveRateSelections(params, stay.usePoints);
  const offers: Offer[] = [];
  const rateResults: RateResult[] = [];
  let complete = true;
  let governmentAvailability: RoomSearchResult["governmentAvailability"] = selections.some(s => s.rateType === "government") ? "unknown" : "not_requested";
  for (const selection of selections) {
    const result: RateResult = { selection, availability: "unknown", offers: [], unmatchedRateCount: 0, coverage: { complete: false, note: "Only verified rate rows are reported; missing terms remain unknown." } };
    rateResults.push(result);
    try {
    const query = staySearchParams(stay, selection);
    query.set("isSearch", "true");
    query.set("showFullPrice", "true");
    const p = await navigate(`${MARRIOTT_BASE_URL}/search/availabilityCalendar.mi?${query}`);
    const state = await waitForResults(p, RATE_RESULTS, NO_ROOMS);
    if (state === "results") await prepareRateList(p);
    await verifyStay(p, stay);
    const filterApplied = await rateFilterApplied(p, selection);
    if (state === "empty") {
      result.availability = filterApplied ? "unavailable" : "unknown";
      result.coverage.complete = filterApplied;
      if (selection.rateType === "government") governmentAvailability = result.availability;
      complete &&= filterApplied;
      continue;
    }
    let exhausted = false;
    let termsComplete = true;
    for (let ratePage = 0; ratePage < 5; ratePage++) {
      await waitForResults(p, RATE_RESULTS, NO_ROOMS);
      await verifyStay(p, stay);
      const raw = await collectRateRows(p);
      const currentFilterApplied = await rateFilterApplied(p, selection);
      const found = raw.map(row => makeOffer(row, stay, selection, currentFilterApplied)).filter((offer): offer is Offer => Boolean(offer));
      result.unmatchedRateCount += raw.length - found.length;
      termsComplete &&= found.length === raw.length && found.every(o => Boolean(o.total && o.taxesIncluded && o.refundability !== "unknown"));
      offers.push(...found);
      result.offers.push(...found);
      if (found.some(o => o.available)) result.availability = "available";
      const next = p.locator('[data-testid="next-rates-page"], button[data-testid="load-more-rates"], a[rel="next"]').first();
      if (!await next.count() || !await next.isEnabled() || await next.getAttribute("aria-disabled") === "true") {
        exhausted = await currentRateListComplete(p)
          || Boolean(await p.locator('[data-testid="rates-complete"], [data-rates-complete="true"]').count())
          || Boolean(await next.count());
        break;
      }
      const before = await p.locator(RATE_ROWS).allTextContents();
      await next.click();
      await p.waitForFunction(({ previous, selector }) => JSON.stringify(Array.from(document.querySelectorAll(selector)).map(el => el.textContent)) !== JSON.stringify(previous), { previous: before, selector: RATE_ROWS }, { timeout: 15000 });
    }
    result.offers = uniqueOffers(result.offers);
    result.coverage.complete = exhausted && termsComplete;
    } catch (error) {
      if (!isUnrecognizedRatePage(error)) throw error;
      result.error = error.message;
      result.coverage.complete = false;
    }
    if (selection.rateType === "government") governmentAvailability = result.availability;
    complete &&= result.coverage.complete;
  }
  const unique = uniqueOffers(offers);
  bookingFlow.remember(unique);
  return {
    offers: unique, rateResults, governmentAvailability, decisionRequired: true,
    coverage: { complete, note: complete ? "All rate rows verified; no rate was selected." : "Only verified visible rate rows are reported; missing totals/terms and unexpanded rates remain unknown." },
  };
}

function uniqueOffers(offers: Offer[]): Offer[] {
  // Different quotes/terms must not overwrite each other merely because codes match.
  return [...new Map(offers.map(o => [JSON.stringify([offerFingerprint(o), o.nightly, o.available]), o])).values()];
}

function isUnrecognizedRatePage(error: unknown): error is Error {
  return error instanceof MarriottPageError && error.code === "PAGE_CHANGED"
    || error instanceof Error && /^(?:UNVERIFIED_STAY|PAGE_CHANGED):/.test(error.message);
}

async function rateFilterApplied(page: Page, selection: RateSelection): Promise<boolean> {
  const actual = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="clusterCode"]:checked, input[type="hidden"][name="clusterCode"], select[name="clusterCode"]');
    return { cluster: input?.value.toLowerCase(), code: document.querySelector<HTMLInputElement>('input[name="corporateCode"]')?.value };
  });
  const expected = { regular: "none", aaa_caa: "aaa", senior: "s9r", government: "gov", corporate_promo: "corp" }[selection.rateType];
  return actual.cluster === expected && (selection.rateType !== "corporate_promo" || actual.code?.toUpperCase() === selection.corporateCode?.toUpperCase());
}

export async function selectRoom(params: { offerId?: string; hotelId?: string; roomCode?: string; ratePlanCode?: string }) {
  return withMutex(browserMutex, async () => bookingFlow.select(params));
}

export async function addExtras(_params: { extras: string[] }) {
  return { success: false, selectedExtras: [], message: "Extras are not implemented by this adapter. Choose a rate with the desired inclusions or arrange extras with the hotel; no extras have been added." };
}

export async function checkout(params: CheckoutRequest) {
  return withMutex(browserMutex, () => bookingFlow.checkout(params));
}

// ─── Reservation Management ────────────────────────────────────────────────────

export async function getReservation(confirmationNumber?: string): Promise<Reservation[]> {
  return withMutex(browserMutex, async () => {
  const { context: ctx } = await initBrowser();
  const p = await getPage();

  const url = `${MARRIOTT_BASE_URL}/loyalty/myTrips/upcoming.mi`;
  assertMarriottUrl(url);
  await p.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT,
  });
  await randomDelay(1500, 2500);

  await waitForResults(p, '[data-testid="trip-card"], .l-trip-card, .trip-card, [class*="tripCard"], [class*="reservationCard"]', '[data-testid="no-trips"], .no-trips');

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  await persistCookies(ctx);

  const reservations = await p.evaluate((targetConfirmation) => {
    const results: Reservation[] = [];

    const cards = document.querySelectorAll(
      '[data-testid="trip-card"], .l-trip-card, .trip-card, [class*="tripCard"], [class*="reservationCard"]'
    );

    cards.forEach((card) => {
      const confirmNum =
        card
          .querySelector('[class*="confirmation"], [data-testid="confirmation-number"]')
          ?.textContent?.trim() || "";

      if (targetConfirmation && !confirmNum.includes(targetConfirmation)) return;

      const hotelName =
        card.querySelector('[class*="hotelName"], [class*="propertyName"], h2, h3')
          ?.textContent?.trim() || "";

      const checkIn =
        card.querySelector('[class*="checkIn"], [data-testid="check-in"]')
          ?.textContent?.trim() || "";

      const checkOut =
        card.querySelector('[class*="checkOut"], [data-testid="check-out"]')
          ?.textContent?.trim() || "";

      const roomType =
        card.querySelector('[class*="roomType"], [data-testid="room-type"]')
          ?.textContent?.trim() || "";

      const status =
        card.querySelector('[class*="status"], [data-testid="status"]')
          ?.textContent?.trim() || "Upcoming";

      const totalPrice =
        card.querySelector('[class*="total"], [class*="price"]')?.textContent?.trim() ||
        undefined;

      results.push({
        confirmationNumber: confirmNum,
        status,
        hotelName,
        checkIn,
        checkOut,
        roomType,
        totalPrice,
      });
    });

    return results;
  }, confirmationNumber || null);

  return reservations;
});
}

export async function modifyReservation(params: {
  confirmationNumber: string;
  newCheckIn?: string;
  newCheckOut?: string;
  newRoomType?: string;
  specialRequests?: string;
  confirm?: boolean;
}): Promise<
  | { requiresConfirmation: true; preview: object }
  | { success: boolean; message: string }
> {
  return withMutex(browserMutex, async () => {
    const { confirmationNumber, newCheckIn, newCheckOut, newRoomType, specialRequests, confirm = false } =
    params;

  const preview = {
    confirmationNumber,
    changes: {
      ...(newCheckIn ? { newCheckIn } : {}),
      ...(newCheckOut ? { newCheckOut } : {}),
      ...(newRoomType ? { newRoomType } : {}),
      ...(specialRequests ? { specialRequests } : {}),
    },
    warning: "Modifying this reservation may affect pricing and availability.",
  };

  if (!confirm) {
    return { requiresConfirmation: true, preview };
  }

  const { context: ctx } = await initBrowser();
  const p = await getPage();

  await p.goto(
    `${MARRIOTT_BASE_URL}/loyalty/myTrips/modifyReservation.mi?confirmationNumber=${confirmationNumber}`,
    { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }
  );
  await randomDelay(1500, 2500);

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  // Attempt date changes
  if (newCheckIn) {
    const checkInField = await p.$('input[name="fromDate"], #fromDate, [data-testid="check-in-date"]').catch(() => null);
    if (!checkInField) throw new Error("Check-in date field missing. No modification submitted.");
    if (checkInField) {
      await checkInField.fill(newCheckIn);
      await randomDelay(300, 600);
    }
  }

  if (newCheckOut) {
    const checkOutField = await p.$('input[name="toDate"], #toDate, [data-testid="check-out-date"]').catch(() => null);
    if (!checkOutField) throw new Error("Check-out date field missing. No modification submitted.");
    if (checkOutField) {
      await checkOutField.fill(newCheckOut);
      await randomDelay(300, 600);
    }
  }

  if (newRoomType) {
    const roomField = p.locator('select[name="roomTypeCode"]');
    if (await roomField.count() !== 1) throw new Error("Room selection field missing. No modification submitted.");
    await roomField.selectOption(newRoomType);
  }

  if (specialRequests) {
    const reqField = await p.$('textarea[name="specialRequests"]').catch(() => null);
    if (!reqField) throw new Error("Special request field missing. No modification submitted.");
    if (reqField) {
      await reqField.fill(specialRequests);
      await randomDelay(200, 500);
    }
  }

  await assertPageUsable(p);
  const submitBtn = p.locator('[data-testid="modify-submit"], button[name="modifyReservation"]');
  if (await submitBtn.count() !== 1 || !await submitBtn.isEnabled()) throw new Error("Unique modification button missing. No modification submitted.");
  try {
    await submitBtn.click();
    await p.locator('[data-testid="modification-confirmed"]').waitFor({ state: "visible", timeout: 15000 });
    await assertPageUsable(p);
  } catch {
    return { success: false, message: "Modification outcome unknown. Check the reservation before retrying." };
  }

  await persistCookies(ctx);

  return {
    success: true,
      message: `Modification submitted for reservation ${confirmationNumber}. Check your email for updated confirmation.`,
    };
  });
}

export async function cancelReservation(params: {
  confirmationNumber: string;
  confirm?: boolean;
}): Promise<
  | { requiresConfirmation: true; preview: object }
  | { success: boolean; cancellationNumber?: string; message: string }
> {
  return withMutex(browserMutex, async () => {
    const { confirmationNumber, confirm = false } = params;

  const preview = {
    confirmationNumber,
    action: "CANCEL RESERVATION",
    warning: "THIS ACTION CANNOT BE UNDONE. Cancellation fees may apply.",
  };

  if (!confirm) {
    return { requiresConfirmation: true, preview };
  }

  const { context: ctx } = await initBrowser();
  const p = await getPage();

  await p.goto(
    `${MARRIOTT_BASE_URL}/loyalty/myTrips/cancelReservation.mi?confirmationNumber=${confirmationNumber}`,
    { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }
  );
  await randomDelay(1500, 2500);

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  // Click cancel confirm button
  await assertPageUsable(p);
  const cancelBtn = p.locator('[data-testid="confirm-cancel"], .l-cancel-confirm');
  if (await cancelBtn.count() !== 1 || !await cancelBtn.isEnabled()) throw new Error("Unique cancellation button missing. No cancellation submitted.");
  try {
    await cancelBtn.click();
    await p.locator('[data-testid="cancellation-number"], [class*="cancellationNumber"]').first().waitFor({ state: "visible", timeout: 15000 });
    await assertPageUsable(p);
  } catch {
    return { success: false, message: "Cancellation outcome unknown. Check the reservation before retrying." };
  }

  const cancellationNumber = await p
    .$eval(
      '[data-testid="cancellation-number"], [class*="cancellationNumber"]',
      (el) => el.textContent?.trim()
    )
    .catch(() => null);

  await persistCookies(ctx);

  return {
    success: Boolean(cancellationNumber),
    cancellationNumber: cancellationNumber || undefined,
    message: cancellationNumber
      ? `Reservation ${confirmationNumber} cancelled. Cancellation number: ${cancellationNumber}`
        : `Cancellation submitted for reservation ${confirmationNumber}. Check your email for confirmation.`,
    };
  });
}

// ─── Check-In ──────────────────────────────────────────────────────────────────

export async function checkIn(params: {
  confirmationNumber: string;
  estimatedArrivalTime?: string;
  roomPreferences?: string;
}): Promise<{ success: boolean; message: string; roomNumber?: string; mobileKeyAvailable?: boolean }> {
  return withMutex(browserMutex, async () => {
  const { confirmationNumber, estimatedArrivalTime, roomPreferences } = params;

  const { context: ctx } = await initBrowser();
  const p = await getPage();

  const checkInUrl = `${MARRIOTT_BASE_URL}/loyalty/myTrips/mobileCheckIn.mi?confirmationNumber=${confirmationNumber}`;
  assertMarriottUrl(checkInUrl);
  await p.goto(checkInUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  await randomDelay(1500, 2500);

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  if (estimatedArrivalTime) {
    const arrivalField = await p
      .$('input[name="estimatedArrival"], select[name="arrivalTime"]')
      .catch(() => null);
    if (arrivalField) {
      await arrivalField.fill(estimatedArrivalTime);
      await randomDelay(300, 600);
    }
  }

  if (roomPreferences) {
    const prefField = await p
      .$('textarea[name="roomPreferences"], input[name="preferences"]')
      .catch(() => null);
    if (prefField) {
      await prefField.fill(roomPreferences);
      await randomDelay(200, 500);
    }
  }

  const checkInBtn = await p
    .$('[data-testid="check-in-submit"], .l-checkin-btn, [class*="checkInBtn"]')
    .catch(() => null);

  if (checkInBtn) {
    await checkInBtn.click();
    await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 2000);
  }

  const roomNumber = await p
    .$eval(
      '[data-testid="room-number"], [class*="roomNumber"]',
      (el) => el.textContent?.trim()
    )
    .catch(() => null);

  const mobileKeyAvailable =
    (await p.$('[class*="mobileKey"], [data-testid="mobile-key"]').catch(() => null)) !== null;

  await persistCookies(ctx);

  return {
    success: true,
    message: roomNumber
      ? `Mobile check-in complete! Room ${roomNumber} is ready.`
      : "Mobile check-in submitted. You'll be notified when your room is ready.",
    roomNumber: roomNumber || undefined,
    mobileKeyAvailable,
  };
});
}

// ─── Bonvoy Status ─────────────────────────────────────────────────────────────

export async function getBonvoyStatus(): Promise<BonvoyStatus> {
  return withMutex(browserMutex, async () => {
  const { context: ctx } = await initBrowser();
  const p = await getPage();

  const url = `${MARRIOTT_BASE_URL}/loyalty/myAccount/dashboard.mi`;
  assertMarriottUrl(url);
  await p.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT,
  });
  await randomDelay(1500, 2500);

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  const status = await p.evaluate(() => {
    const memberNumber =
      document
        .querySelector('[data-testid="member-number"], [class*="memberNumber"]')
        ?.textContent?.trim() || undefined;

    const memberName =
      document
        .querySelector('[data-testid="member-name"], [class*="memberName"]')
        ?.textContent?.trim() || undefined;

    const tier =
      document
        .querySelector('[data-testid="tier"], [class*="tier"], [class*="Tier"]')
        ?.textContent?.trim() || undefined;

    const pointsEl = document.querySelector(
      '[data-testid="points-balance"], [class*="pointsBalance"], [class*="points-balance"]'
    );
    const pointsText = pointsEl?.textContent || "";
    const pointsMatch = pointsText.match(/([\d,]+)/);
    const points = pointsMatch ? parseInt(pointsMatch[1].replace(",", "")) : undefined;

    const nightsEl = document.querySelector('[class*="nightsThisYear"], [class*="nights-this-year"]');
    const nightsText = nightsEl?.textContent || "";
    const nightsMatch = nightsText.match(/(\d+)/);
    const nightsThisYear = nightsMatch ? parseInt(nightsMatch[1]) : undefined;

    const nextTierEl = document.querySelector('[class*="nightsToNext"], [class*="nextTier"]');
    const nextTierText = nextTierEl?.textContent || "";
    const toNextMatch = nextTierText.match(/(\d+)/);
    const nightsToNextTier = toNextMatch ? parseInt(toNextMatch[1]) : undefined;

    const nextTier = document
      .querySelector('[class*="nextTierName"]')
      ?.textContent?.trim() || undefined;

    const expirationDate = document
      .querySelector('[class*="expiration"], [class*="expires"]')
      ?.textContent?.trim() || undefined;

    const recentActivity: Array<{ date: string; description: string; points: number }> = [];
    document
      .querySelectorAll('[class*="activityRow"], [class*="activity-item"], [data-testid="activity-item"]')
      .forEach((row) => {
        const date = row.querySelector('[class*="date"]')?.textContent?.trim() || "";
        const desc =
          row.querySelector('[class*="description"], [class*="title"]')?.textContent?.trim() || "";
        const pts = row.querySelector('[class*="points"]')?.textContent?.match(/([-\d,]+)/);
        if (date || desc) {
          recentActivity.push({
            date,
            description: desc,
            points: pts ? parseInt(pts[1].replace(",", "")) : 0,
          });
        }
      });

    return {
      memberNumber,
      memberName,
      tier,
      points,
      nightsThisYear,
      nightsToNextTier,
      nextTier,
      expirationDate,
      recentActivity: recentActivity.slice(0, 10),
    };
  });

  await persistCookies(ctx);
  return status;
});
}

// ─── Redeem Points ─────────────────────────────────────────────────────────────

export async function redeemPoints(params: CheckoutRequest) {
  return withMutex(browserMutex, () => bookingFlow.checkout(params, "redeem_points", true));
}

// ─── Stay History ──────────────────────────────────────────────────────────────

export async function getStayHistory(params: {
  limit?: number;
}): Promise<StayHistory> {
  return withMutex(browserMutex, async () => {
  const { limit = 20 } = params;

  const { context: ctx } = await initBrowser();
  const p = await getPage();

  const url = `${MARRIOTT_BASE_URL}/loyalty/myTrips/pastStays.mi`;
  assertMarriottUrl(url);
  await p.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT,
  });
  await randomDelay(1500, 2500);

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  const history = await p.evaluate((maxStays) => {
    const stays: StayHistory["stays"] = [];

    const cards = document.querySelectorAll(
      '[data-testid="stay-card"], .l-stay-card, [class*="stayCard"], [class*="pastStay"]'
    );

    let totalNights = 0;

    cards.forEach((card, index) => {
      if (index >= maxStays) return;

      const hotelName =
        card.querySelector('[class*="hotelName"], [class*="propertyName"], h2, h3')
          ?.textContent?.trim() || "";

      const location =
        card.querySelector('[class*="location"], [class*="address"]')
          ?.textContent?.trim() || undefined;

      const confirmNum =
        card.querySelector('[class*="confirmation"]')?.textContent?.trim() || "";

      const checkIn =
        card.querySelector('[class*="checkIn"], [data-testid="check-in"]')
          ?.textContent?.trim() || "";

      const checkOut =
        card.querySelector('[class*="checkOut"], [data-testid="check-out"]')
          ?.textContent?.trim() || "";

      const nightsEl = card.querySelector('[class*="nights"]');
      const nightsText = nightsEl?.textContent || "";
      const nightsMatch = nightsText.match(/(\d+)/);
      const nights = nightsMatch ? parseInt(nightsMatch[1]) : 1;
      totalNights += nights;

      const roomType =
        card.querySelector('[class*="roomType"]')?.textContent?.trim() || undefined;

      const pointsEl = card.querySelector('[class*="points"]');
      const pointsText = pointsEl?.textContent || "";
      const pointsMatch = pointsText.match(/([\d,]+)/);
      const pointsEarned = pointsMatch ? parseInt(pointsMatch[1].replace(",", "")) : undefined;

      const totalCost =
        card.querySelector('[class*="total"], [class*="price"]')
          ?.textContent?.trim() || undefined;

      stays.push({
        confirmationNumber: confirmNum,
        hotelName,
        location,
        checkIn,
        checkOut,
        nights,
        roomType,
        pointsEarned,
        totalCost,
        status: "Completed",
      });
    });

    return { stays, totalNights };
  }, limit);

  await persistCookies(ctx);

  return {
    stays: history.stays,
    totalStays: history.stays.length,
    totalNights: history.totalNights,
  };
});
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function calcNights(checkIn: string, checkOut: string): number {
  const d1 = new Date(checkIn);
  const d2 = new Date(checkOut);
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}
