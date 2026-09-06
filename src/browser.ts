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
  type SessionInfo,
} from "./secure-store.js";
import { BrowserMutex, withMutex } from "./mutex.js";

const MARRIOTT_BASE_URL = "https://www.marriott.com";
const DEFAULT_TIMEOUT = 30000;

// Singleton browser instance
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// In-memory state for booking flow
let selectedHotelId: string | null = null;
let selectedRoomCode: string | null = null;
let selectedRatePlanCode: string | null = null;

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

export interface RoomOption {
  code: string;
  name: string;
  description?: string;
  maxGuests?: number;
  bedType?: string;
  sqft?: number;
  view?: string;
  pricePerNight?: string;
  totalPrice?: string;
  ratePlanCode?: string;
  ratePlanName?: string;
  freeCancellation?: boolean;
  breakfastIncluded?: boolean;
  pointsEarned?: number;
  pointsRequired?: number;
  available?: boolean;
  imageUrl?: string;
}

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
  if (browser && context && page) {
    return { browser, context, page };
  }

  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
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
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Patch navigator to avoid bot detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  // Load saved cookies if available
  await loadCookies(context);

  page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  return { browser, context, page };
}

export async function closeBrowser(): Promise<void> {
  return withMutex(browserMutex, async () => {
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
});
}

async function getPage(): Promise<Page> {
  const { page: p } = await initBrowser();
  return p;
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
    const currentUrl = p.url();
    if (currentUrl.includes("signin") || currentUrl.includes("login")) {
      const info: SessionInfo = {
        isLoggedIn: false,
        lastUpdated: new Date().toISOString(),
      };
      saveSessionInfo(info);
      return info;
    }

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
      isLoggedIn: true,
      userName: userName || undefined,
      bonvoyNumber: bonvoyNumber || undefined,
      bonvoyTier: tier || undefined,
      lastUpdated: new Date().toISOString(),
    };

    await saveCookies(ctx);
    saveSessionInfo(info);
    return info;
  } catch (error) {
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
  const credentials = getCredentials();

  if (credentials) {
    return await performLogin(credentials.email, credentials.password);
  }

  return {
    message: "Manual login required",
    loginUrl: `${MARRIOTT_BASE_URL}/loyalty/loginPage.mi`,
    instructions:
      "Set MARRIOTT_EMAIL and MARRIOTT_PASSWORD environment variables for automatic login, or visit the loginUrl to sign in manually. After signing in, use status to verify.",
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

    await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });
    await randomDelay(1000, 2000);

    const currentUrl = p.url();
    if (currentUrl.includes("signin") || currentUrl.includes("login")) {
      throw new Error("Login failed. Please check credentials or try manual login.");
    }

    await saveCookies(ctx);

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
        "Automatic login encountered an issue. Try visiting the loginUrl manually, then use status to verify.",
    };
  }
}

// ─── Hotel Search ──────────────────────────────────────────────────────────────

export async function searchHotels(params: {
  destination: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
  maxResults?: number;
}): Promise<HotelResult[]> {
  return withMutex(browserMutex, async () => {
  const {
    destination,
    checkIn,
    checkOut,
    adults = 1,
    children = 0,
    rooms = 1,
    maxResults = 10,
  } = params;

  const p = await getPage();

  // Build search URL
  const searchParams = new URLSearchParams({
    "destinationAddress.destination": destination,
    "fromDate": checkIn,
    "toDate": checkOut,
    "numberOfRooms": String(rooms),
    "guestCounts[0].numAdults": String(adults),
    "guestCounts[0].numChildren": String(children),
    "numberOfNights": String(calcNights(checkIn, checkOut)),
  });

  const searchUrl = `${MARRIOTT_BASE_URL}/search/findHotels.mi?${searchParams.toString()}`;

  assertMarriottUrl(searchUrl);
  await p.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  await randomDelay(2000, 4000);

  // Wait for hotel cards
  try {
    await p.waitForSelector(
      '[data-testid="property-card"], .l-property-card, .property-card, [class*="propertyCard"]',
      { timeout: 15000 }
    );
  } catch {
    // Try waiting for any results
    await p.waitForSelector('.search-results, #search-results, [class*="searchResult"]', {
      timeout: 10000,
    }).catch(() => {});
  }

  await randomDelay(500, 1000);

  const hotels = await p.evaluate((limit) => {
    const results: HotelResult[] = [];

    // Try multiple card selectors
    const cards = document.querySelectorAll(
      '[data-testid="property-card"], .l-property-card, .property-card, [class*="propertyCard"], [class*="hotel-card"]'
    );

    let count = 0;
    cards.forEach((card, index) => {
      if (count >= limit) return;

      const name =
        card.querySelector('[data-testid="property-name"], .l-property-name, .property-name, h2, h3')
          ?.textContent?.trim() || "";

      if (!name) return;

      const id =
        card.getAttribute("data-property-id") ||
        card.getAttribute("data-hotel-id") ||
        card.querySelector("a")?.href?.match(/propertyCode=([A-Z0-9]+)/)?.[1] ||
        String(index);

      const url =
        card.querySelector("a[href*='propertyPage']")?.getAttribute("href") ||
        card.querySelector("a")?.getAttribute("href") || "";

      const priceEl = card.querySelector(
        '[data-testid="price"], .l-price, .price, [class*="price"]'
      );
      const priceText = priceEl?.textContent?.trim() || "";
      const priceMatch = priceText.match(/\$[\d,]+/);

      const ratingEl = card.querySelector(
        '[data-testid="star-rating"], [aria-label*="star"], [class*="starRating"], [class*="star-rating"]'
      );
      const ratingText = ratingEl?.getAttribute("aria-label") || ratingEl?.textContent || "";
      const starMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:out of\s*\d+\s*)?star/i);

      const guestRatingEl = card.querySelector(
        '[data-testid="guest-rating"], [class*="guestRating"], [class*="reviewScore"]'
      );

      const locationEl = card.querySelector(
        '[data-testid="location"], .l-location, [class*="location"], [class*="address"]'
      );

      const imgEl = card.querySelector("img");

      const brand =
        card.getAttribute("data-brand") ||
        card.querySelector('[class*="brand"]')?.textContent?.trim() || undefined;

      const freeCancellation =
        card.querySelector('[class*="freeCancel"], [class*="free-cancel"]') !== null ||
        card.textContent?.toLowerCase().includes("free cancellation") || false;

      results.push({
        id,
        name,
        brand,
        url: url.startsWith("http") ? url : `https://www.marriott.com${url}`,
        starRating: starMatch ? parseFloat(starMatch[1]) : undefined,
        guestRating: guestRatingEl?.textContent?.trim() || undefined,
        location: locationEl?.textContent?.trim() || undefined,
        pricePerNight: priceMatch ? priceMatch[0] : undefined,
        imageUrl: imgEl?.src || imgEl?.getAttribute("data-src") || undefined,
        freeCancellation,
      });

      count++;
    });

    return results;
  }, Math.min(maxResults, 50));

  return hotels;
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

export async function getRoomOptions(params: {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  usePoints?: boolean;
}): Promise<RoomOption[]> {
  return withMutex(browserMutex, async () => {
    const { hotelId, checkIn, checkOut, adults = 1, children = 0, usePoints = false } = params;
    const p = await getPage();

  const searchParams = new URLSearchParams({
    propertyCode: hotelId,
    fromDate: checkIn,
    toDate: checkOut,
    "guestCounts[0].numAdults": String(adults),
    "guestCounts[0].numChildren": String(children),
    numberOfRooms: "1",
    ...(usePoints ? { redeemPoints: "true" } : {}),
  });

  const url = `${MARRIOTT_BASE_URL}/hotels/rooms/${hotelId}.mi?${searchParams.toString()}`;
  assertMarriottUrl(url);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  await randomDelay(2000, 3500);

  selectedHotelId = hotelId;

  const rooms = await p.evaluate(() => {
    const results: RoomOption[] = [];

    const cards = document.querySelectorAll(
      '[data-testid="room-type-card"], .l-room-type, .room-type, [class*="roomType"], [class*="room-card"]'
    );

    cards.forEach((card, index) => {
      const name =
        card.querySelector(
          '[data-testid="room-name"], .room-name, h2, h3, [class*="roomName"]'
        )?.textContent?.trim() || `Room ${index + 1}`;

      const code =
        card.getAttribute("data-room-type-code") ||
        card.getAttribute("data-room-code") ||
        String(index);

      const description = card.querySelector('[class*="description"]')
        ?.textContent?.trim() || undefined;

      const bedType = card.querySelector('[class*="bed"], [data-testid="bed-type"]')
        ?.textContent?.trim() || undefined;

      const maxGuests = (() => {
        const guestEl = card.querySelector('[class*="maxGuest"], [class*="occupancy"]');
        const match = guestEl?.textContent?.match(/\d+/);
        return match ? parseInt(match[0]) : undefined;
      })();

      const sqft = (() => {
        const sizeEl = card.querySelector('[class*="sqft"], [class*="size"], [class*="area"]');
        const match = sizeEl?.textContent?.match(/(\d+)\s*(?:sq\.?\s*ft|sqft)/i);
        return match ? parseInt(match[1]) : undefined;
      })();

      const view = card.querySelector('[class*="view"]')?.textContent?.trim() || undefined;

      const priceEl = card.querySelector(
        '[data-testid="price"], .l-price, [class*="price"], [class*="rate"]'
      );
      const priceText = priceEl?.textContent?.trim() || "";
      const priceMatch = priceText.match(/\$[\d,]+/);

      const ratePlanCode =
        card.getAttribute("data-rate-plan-code") ||
        card.querySelector("[data-rate-plan]")?.getAttribute("data-rate-plan") || undefined;

      const ratePlanName = card.querySelector('[class*="ratePlan"], [class*="rate-plan"]')
        ?.textContent?.trim() || undefined;

      const freeCancellation =
        card.querySelector('[class*="freeCancel"]') !== null ||
        card.textContent?.toLowerCase().includes("free cancellation") || false;

      const breakfastIncluded =
        card.textContent?.toLowerCase().includes("breakfast") &&
        card.textContent?.toLowerCase().includes("included") || false;

      const pointsEl = card.querySelector('[class*="points"], [class*="Points"]');
      const pointsText = pointsEl?.textContent || "";
      const pointsMatch = pointsText.match(/([\d,]+)\s*points?/i);
      const pointsNum = pointsMatch ? parseInt(pointsMatch[1].replace(",", "")) : undefined;

      const imgEl = card.querySelector("img");

      results.push({
        code,
        name,
        description,
        bedType,
        maxGuests,
        sqft,
        view,
        pricePerNight: priceMatch ? priceMatch[0] : undefined,
        ratePlanCode,
        ratePlanName,
        freeCancellation,
        breakfastIncluded,
        pointsRequired: pointsNum,
        available: true,
        imageUrl: imgEl?.src || imgEl?.getAttribute("data-src") || undefined,
      });
    });

    return results;
  });

    return rooms;
  });
}

// ─── Select Room ───────────────────────────────────────────────────────────────

export async function selectRoom(params: {
  hotelId: string;
  roomCode: string;
  ratePlanCode?: string;
}): Promise<{ success: boolean; message: string; nextStep: string }> {
  const { hotelId, roomCode, ratePlanCode } = params;

  selectedHotelId = hotelId;
  selectedRoomCode = roomCode;
  selectedRatePlanCode = ratePlanCode || null;

  return {
    success: true,
    message: `Room ${roomCode} selected at hotel ${hotelId}${ratePlanCode ? ` with rate plan ${ratePlanCode}` : ""}.`,
    nextStep: "Use add_extras to add optional services, or proceed to checkout.",
  };
}

// ─── Add Extras ────────────────────────────────────────────────────────────────

let pendingExtras: string[] = [];

export async function addExtras(params: {
  extras: Array<"parking" | "breakfast" | "late_checkout" | "early_checkin" | "airport_transfer" | "spa_credit">;
}): Promise<{ success: boolean; selectedExtras: string[]; message: string }> {
  pendingExtras = params.extras;

  return {
    success: true,
    selectedExtras: params.extras,
    message: `Extras queued: ${params.extras.join(", ")}. Proceed to checkout to apply them.`,
  };
}

// ─── Checkout ──────────────────────────────────────────────────────────────────

export async function checkout(params: {
  hotelId?: string;
  roomCode?: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
  confirm?: boolean;
}): Promise<
  | { requiresConfirmation: true; preview: object }
  | { success: boolean; confirmationNumber?: string; message: string }
> {
  return withMutex(browserMutex, async () => {
    const {
    hotelId = selectedHotelId,
    roomCode = selectedRoomCode,
    checkIn,
    checkOut,
    adults = 1,
    children = 0,
    firstName,
    lastName,
    email,
    phone,
    specialRequests,
    confirm = false,
  } = params;

  if (!hotelId || !roomCode) {
    return {
      success: false,
      message: "No hotel or room selected. Use search_hotels, get_room_options, and select_room first.",
    };
  }

  const preview = {
    hotelId,
    roomCode,
    checkIn,
    checkOut,
    adults,
    children,
    extras: pendingExtras,
    guestName: firstName && lastName ? `${firstName} ${lastName}` : undefined,
    email,
    specialRequests,
    warning: "THIS WILL CHARGE YOUR SAVED PAYMENT METHOD. Confirm only if sure.",
  };

  if (!confirm) {
    return {
      requiresConfirmation: true,
      preview,
    };
  }

  const { context: ctx } = await initBrowser();
  const p = await getPage();

  // Navigate to booking page
  const searchParams = new URLSearchParams({
    propertyCode: hotelId,
    roomTypeCode: roomCode,
    fromDate: checkIn,
    toDate: checkOut,
    "guestCounts[0].numAdults": String(adults),
    "guestCounts[0].numChildren": String(children),
    numberOfRooms: "1",
    ...(selectedRatePlanCode ? { ratePlanCode: selectedRatePlanCode } : {}),
  });

  const checkoutUrl = `${MARRIOTT_BASE_URL}/reservation/rateListMenu.mi?${searchParams.toString()}`;
  assertMarriottUrl(checkoutUrl);
  await p.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  await randomDelay(2000, 3000);

  try {
    // Fill guest info if provided
    if (firstName) {
      const firstNameField = await p.$('input[name="firstName"], #firstName').catch(() => null);
      if (firstNameField) {
        await firstNameField.fill(firstName);
        await randomDelay(200, 500);
      }
    }

    if (lastName) {
      const lastNameField = await p.$('input[name="lastName"], #lastName').catch(() => null);
      if (lastNameField) {
        await lastNameField.fill(lastName);
        await randomDelay(200, 500);
      }
    }

    if (email) {
      const emailField = await p.$('input[name="email"], input[type="email"]').catch(() => null);
      if (emailField) {
        await emailField.fill(email);
        await randomDelay(200, 500);
      }
    }

    if (phone) {
      const phoneField = await p.$('input[name="phone"], input[type="tel"]').catch(() => null);
      if (phoneField) {
        await phoneField.fill(phone);
        await randomDelay(200, 500);
      }
    }

    if (specialRequests) {
      const reqField = await p
        .$('textarea[name="specialRequests"], textarea[id*="special"]')
        .catch(() => null);
      if (reqField) {
        await reqField.fill(specialRequests);
        await randomDelay(200, 500);
      }
    }

    // Submit booking
    const submitBtn = await p.waitForSelector(
      'button[type="submit"], [data-testid="complete-booking"], .l-submit-btn, [class*="submitBtn"]',
      { timeout: 10000 }
    );
    await submitBtn.click();

    await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });
    await randomDelay(1500, 2500);

    // Extract confirmation number
    const confirmationNumber = await p
      .$eval(
        '[data-testid="confirmation-number"], .l-confirmation-number, [class*="confirmationNumber"], [class*="confirmation-number"]',
        (el) => el.textContent?.trim()
      )
      .catch(() => null);

    await saveCookies(ctx);

    // Clear state
    selectedHotelId = null;
    selectedRoomCode = null;
    selectedRatePlanCode = null;
    pendingExtras = [];

    return {
      success: true,
      confirmationNumber: confirmationNumber || "See email for confirmation",
      message: confirmationNumber
        ? `Booking confirmed! Confirmation number: ${confirmationNumber}`
        : "Booking submitted. Check your email for confirmation details.",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Checkout failed: ${msg}. The booking may not have completed.`,
      };
    }
  });
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

  if (p.url().includes("signin") || p.url().includes("login")) {
    throw new Error("Authentication required. Use login to sign in first.");
  }

  await saveCookies(ctx);

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
    if (checkInField) {
      await checkInField.fill(newCheckIn);
      await randomDelay(300, 600);
    }
  }

  if (newCheckOut) {
    const checkOutField = await p.$('input[name="toDate"], #toDate, [data-testid="check-out-date"]').catch(() => null);
    if (checkOutField) {
      await checkOutField.fill(newCheckOut);
      await randomDelay(300, 600);
    }
  }

  if (specialRequests) {
    const reqField = await p.$('textarea[name="specialRequests"]').catch(() => null);
    if (reqField) {
      await reqField.fill(specialRequests);
      await randomDelay(200, 500);
    }
  }

  const submitBtn = await p
    .$('button[type="submit"], [data-testid="modify-submit"], [class*="modify-btn"]')
    .catch(() => null);

  if (submitBtn) {
    await submitBtn.click();
    await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });
    await randomDelay(1000, 2000);
  }

  await saveCookies(ctx);

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
  const cancelBtn = await p
    .waitForSelector(
      '[data-testid="confirm-cancel"], .l-cancel-confirm, [class*="cancelConfirm"], button[id*="cancel"]',
      { timeout: 10000 }
    )
    .catch(() => null);

  if (cancelBtn) {
    await cancelBtn.click();
    await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });
    await randomDelay(1000, 2000);
  }

  const cancellationNumber = await p
    .$eval(
      '[data-testid="cancellation-number"], [class*="cancellationNumber"]',
      (el) => el.textContent?.trim()
    )
    .catch(() => null);

  await saveCookies(ctx);

  return {
    success: true,
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

  await saveCookies(ctx);

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

  await saveCookies(ctx);
  return status;
});
}

// ─── Redeem Points ─────────────────────────────────────────────────────────────

export async function redeemPoints(params: {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  roomCode?: string;
  confirm?: boolean;
}): Promise<
  | { requiresConfirmation: true; preview: object }
  | { success: boolean; confirmationNumber?: string; pointsUsed?: number; message: string }
> {
  return withMutex(browserMutex, async () => {
  const { hotelId, checkIn, checkOut, adults = 1, roomCode, confirm = false } = params;

  // Get available point rates
  const rooms = await getRoomOptions({
    hotelId,
    checkIn,
    checkOut,
    adults,
    usePoints: true,
  });

  const pointsRooms = rooms.filter((r) => r.pointsRequired && r.pointsRequired > 0);

  if (!confirm) {
    return {
      requiresConfirmation: true,
      preview: {
        hotelId,
        checkIn,
        checkOut,
        adults,
        availablePointsRooms: pointsRooms.slice(0, 5),
        selectedRoom: roomCode || "Not specified — choose from availablePointsRooms",
        warning: "THIS WILL REDEEM MARRIOTT BONVOY POINTS. Confirm only if sure.",
      },
    };
  }

  const targetRoom = roomCode
    ? rooms.find((r) => r.code === roomCode)
    : pointsRooms[0];

  if (!targetRoom) {
    return {
      success: false,
      message: "No points-eligible room found. Check availability or choose a different room.",
    };
  }

  selectedHotelId = hotelId;
  selectedRoomCode = targetRoom.code;
  selectedRatePlanCode = targetRoom.ratePlanCode || null;

  const result = await checkout({
    hotelId,
    roomCode: targetRoom.code,
    checkIn,
    checkOut,
    adults,
    confirm: true,
  });

  if ("success" in result) {
    return {
      ...result,
      pointsUsed: targetRoom.pointsRequired,
    };
  }

  return { success: false, message: "Redemption could not be completed." };
});
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

  await saveCookies(ctx);

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
