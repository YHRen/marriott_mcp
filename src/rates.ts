import { createHash, randomUUID } from "node:crypto";
import { selectionFrom, type RateSelection, type SpecialRate } from "./rate-options.js";

export type RateType = SpecialRate;
export interface Stay {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  usePoints: boolean;
}

export interface Money {
  currency: string;
  minorUnits: number;
  fractionDigits: number;
}

/** Values from ONE rate row, never from an enclosing room's other rates. */
export interface RawRate {
  code: string;
  name: string;
  ratePlanCode: string;
  ratePlanName: string;
  nightly: string;
  total: string;
  currency: string;
  taxesIncluded: boolean;
  cancellationPolicy: string;
  cancellationDeadline: string;
  depositPolicy: string;
  eligibility: string;
  available: boolean;
  bookingUrl: string;
  points: string;
}

export interface Offer extends Stay {
  offerId: string;
  code: string;
  name: string;
  ratePlanCode: string;
  ratePlanName: string;
  rateType: RateType;
  requestedSelection: RateSelection;
  governmentCategory: "federal" | "state" | "military" | "unspecified" | "not_applicable";
  pricePerNight?: string;
  totalPrice?: string;
  nightly?: Money;
  total?: Money;
  taxesIncluded: boolean;
  refundability: "refundable" | "nonrefundable" | "unknown";
  freeCancellation?: boolean;
  cancellationPolicy: string;
  cancellationDeadline: string;
  depositPolicy: string;
  eligibility: string;
  available: boolean;
  pointsRequired?: number;
  bookingUrl: string;
  observedAt: string;
}

/** Currency must be explicit; a bare '$' does not establish USD. */
export function parseMoney(text: string, currencyHint = ""): Money | undefined {
  const currencies = Intl.supportedValuesOf("currency");
  const codes = [...new Set((text.match(/\b[A-Z]{3}\b/g) || []).filter(c => currencies.includes(c)))];
  const symbols = text.includes("€") ? "EUR" : text.includes("£") ? "GBP" : "";
  const currency = codes.length === 1 ? codes[0] : symbols || currencyHint;
  if (codes.length > 1 || !currencies.includes(currency) || (currencyHint && currencyHint !== currency)) return;
  const matches = text.match(/\d[\d.,\u00a0 ]*\d|\d/g);
  if (!matches || matches.length !== 1 || /-\s*\d/.test(text)) return;
  let value = matches[0].replace(/[\s\u00a0]/g, "");
  const fractionDigits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!;
  // Accept standard English grouping, or unambiguous European decimal/grouping.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(value)) value = value.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(value)) value = value.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(value)) return;
  if ((value.split(".")[1]?.length || 0) > fractionDigits) return;
  const minorUnits = Math.round(Number(value) * 10 ** fractionDigits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return;
  return { currency, minorUnits, fractionDigits };
}

export function refundability(policy: string, deposit: string, deadline: string, now = Date.now()): Offer["refundability"] {
  if (/non[ -]?refundable|no refunds|cannot be cancel/i.test(`${policy} ${deposit}`)) return "nonrefundable";
  // A local-time phrase without an offset cannot safely be compared to UTC.
  const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(deadline) ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(instant) || instant <= now) return "unknown";
  if (!/free cancellation|fully refundable|cancel.{0,100}(?:no charge|without (?:a )?penalty)/i.test(policy)) return "unknown";
  if (!deposit || /deposit|prepay|advance payment/i.test(deposit) && !/refundable|no deposit|no prepay/i.test(deposit)) return "unknown";
  return "refundable";
}

export function makeOffer(raw: RawRate, stay: Stay, requestedRate: RateType | RateSelection, filterApplied = false): Offer | undefined {
  if (!/^[a-z0-9_-]+$/i.test(raw.code) || !/^[a-z0-9_-]+$/i.test(raw.ratePlanCode)) return;
  const selection = selectionFrom(requestedRate);
  const terms = `${raw.ratePlanName} ${raw.eligibility}`;
  const government = /government|military|\bgovt?\b|\bper diem\b/i.test(terms);
  const federalExcluded = /non[ -]?federal|federal.{0,60}(?:not eligible|not valid|not accepted|excluded|ineligible)|(?:not for|excluding|except)\s+federal/i.test(terms);
  const governmentCategory: Offer["governmentCategory"] = !government ? "not_applicable"
    : /\bfederal\b/i.test(terms) && !federalExcluded ? "federal" : /\bstate\b|\blocal government\b/i.test(terms) ? "state"
    : /military/i.test(terms) ? "military" : "unspecified";
  const actualRate: RateType = government ? "government" : /\bAAA\b|\bCAA\b/i.test(terms) ? "aaa_caa"
    : /senior|(?:age|aged)\s*62|62\s*(?:years|and older|or older)/i.test(terms) ? "senior"
    : /corporate|negotiated|promo(?:tion)?|company rate/i.test(terms) ? "corporate_promo" : "regular";
  // A query parameter alone is not evidence the website applied the rate filter.
  if (actualRate !== selection.rateType) return;
  if (selection.rateType === "government" && selection.governmentScope === "federal" && governmentCategory !== "federal") return;
  if (selection.rateType === "corporate_promo" && (!filterApplied || !selection.corporateCode)) return;
  const total = parseMoney(raw.total, raw.currency);
  const nightly = parseMoney(raw.nightly, raw.currency);
  const refund = refundability(raw.cancellationPolicy, raw.depositPolicy, raw.cancellationDeadline);
  const points = raw.points.match(/^\s*([\d,]+)\s*(?:points?)?\s*$/i);
  return {
    ...stay, offerId: randomUUID(), code: raw.code, name: raw.name,
    ratePlanCode: raw.ratePlanCode, ratePlanName: raw.ratePlanName,
    rateType: actualRate, requestedSelection: { ...selection }, governmentCategory,
    nightly, total, pricePerNight: raw.nightly || undefined, totalPrice: raw.total || undefined,
    taxesIncluded: raw.taxesIncluded, refundability: refund,
    freeCancellation: refund === "unknown" ? undefined : refund === "refundable",
    cancellationPolicy: raw.cancellationPolicy, cancellationDeadline: raw.cancellationDeadline,
    depositPolicy: raw.depositPolicy, eligibility: raw.eligibility,
    available: raw.available, bookingUrl: raw.bookingUrl,
    pointsRequired: points ? Number(points[1].replace(/,/g, "")) : undefined,
    observedAt: new Date().toISOString(),
  };
}

/** Quote identity includes every term approved by the user, excluding timestamps/URL. */
export function offerFingerprint(offer: Offer): string {
  return createHash("sha256").update(JSON.stringify([
    offer.hotelId, offer.code, offer.ratePlanCode, offer.rateType, offer.requestedSelection, offer.governmentCategory,
    offer.checkIn, offer.checkOut, offer.adults, offer.children, offer.rooms,
    offer.usePoints, offer.total, offer.pointsRequired, offer.taxesIncluded,
    offer.refundability, offer.cancellationPolicy, offer.cancellationDeadline, offer.depositPolicy, offer.eligibility,
  ])).digest("hex");
}

export function assertBookable(offer: Offer): void {
  if (!offer.available || !offer.total || !offer.taxesIncluded || !offer.cancellationPolicy || !offer.depositPolicy) {
    throw new Error("UNVERIFIED_OFFER: Full stay total including taxes/fees and rate terms must be available before booking.");
  }
  if (offer.rateType === "government" && !offer.eligibility) throw new Error("UNVERIFIED_OFFER: Government eligibility terms are missing.");
  if (offer.rateType !== "regular" && !offer.eligibility) throw new Error("UNVERIFIED_OFFER: Special-rate eligibility terms are missing.");
  if (offer.usePoints && (!offer.pointsRequired || offer.pointsRequired <= 0)) throw new Error("UNVERIFIED_OFFER: Exact points total is missing.");
}

export function compareOffers(offers: Offer[]) {
  // Never sort across currencies or compare nightly prices against stay totals.
  const eligible = offers.filter(o => o.available && o.total && o.taxesIncluded && !o.usePoints);
  const currencies = [...new Set(eligible.map(o => o.total!.currency))].sort();
  const cheapest = (items: Offer[]): Offer | null => [...items].sort((a, b) => a.total!.minorUnits - b.total!.minorUnits)[0] || null;
  return currencies.map(currency => {
    const group = eligible.filter(o => o.total!.currency === currency);
    return {
      currency,
      lowestRefundable: cheapest(group.filter(o => o.refundability === "refundable")),
      lowestGovernment: cheapest(group.filter(o => o.rateType === "government")),
      lowestRefundableGovernment: cheapest(group.filter(o => o.rateType === "government" && o.refundability === "refundable")),
    };
  });
}

export function staySearchParams(stay: Omit<Stay, "hotelId"> & { hotelId?: string }, requested: RateType | RateSelection): URLSearchParams {
  const selection = selectionFrom(requested);
  const clusterCode = { regular: "none", aaa_caa: "aaa", senior: "S9R", government: "gov", corporate_promo: "corp" }[selection.rateType];
  if (selection.rateType === "corporate_promo" && !selection.corporateCode) throw new Error("corporate_promo requires corporateCode.");
  const websiteDate = (date: string) => date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
  const params = new URLSearchParams({
    fromDate: websiteDate(stay.checkIn), toDate: websiteDate(stay.checkOut),
    flexibleDateSearch: "false", isFlexibleDatesOptionSelected: "false",
    numberOfRooms: String(stay.rooms),
    clusterCode,
    corporateCode: selection.corporateCode || "",
    redeemPoints: String(stay.usePoints),
  });
  if (stay.hotelId) params.set("propertyCode", stay.hotelId);
  for (let room = 0; room < stay.rooms; room++) {
    params.set(`guestCounts[${room}].numAdults`, String(stay.adults));
    params.set(`guestCounts[${room}].numChildren`, String(stay.children));
  }
  return params;
}
