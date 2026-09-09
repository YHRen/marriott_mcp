import { describe, it, expect } from "vitest";
import { compareOffers, makeOffer, parseMoney, refundability, staySearchParams, type RawRate, type Stay } from "../src/rates.js";

export const stay: Stay = { hotelId: "NYCMQ", checkIn: "2099-07-01", checkOut: "2099-07-03", adults: 2, children: 0, rooms: 1, usePoints: false };
export const raw: RawRate = {
  code: "KING", name: "King", ratePlanCode: "FLEX", ratePlanName: "Flexible",
  nightly: "USD 190.25", total: "USD 430.50", currency: "USD", taxesIncluded: true,
  cancellationPolicy: "Free cancellation before the deadline", cancellationDeadline: "2099-06-30T18:00:00-04:00",
  depositPolicy: "No deposit required", eligibility: "", available: true, bookingUrl: "", points: "",
};

describe("money and cancellation terms", () => {
  it("preserves cents and recognizes explicit currencies", () => {
    expect(parseMoney("USD 1,234.56")?.minorUnits).toBe(123456);
    expect(parseMoney("1.234,56 EUR")?.minorUnits).toBe(123456);
    expect(parseMoney("JPY 12,345")?.minorUnits).toBe(12345);
    expect(parseMoney("$100")).toBeUndefined();
    expect(parseMoney("USD 100", "CAD")).toBeUndefined();
    expect(parseMoney("USD 100 + 20 taxes")).toBeUndefined();
  });
  it("treats missing, elapsed or ambiguous deadlines conservatively", () => {
    expect(refundability(raw.cancellationPolicy, raw.depositPolicy, raw.cancellationDeadline)).toBe("refundable");
    expect(refundability(raw.cancellationPolicy, "Non-refundable deposit", raw.cancellationDeadline)).toBe("nonrefundable");
    expect(refundability(raw.cancellationPolicy, raw.depositPolicy, "18:00 local time")).toBe("unknown");
    expect(refundability(raw.cancellationPolicy, raw.depositPolicy, "2000-01-01T18:00:00Z")).toBe("unknown");
    expect(refundability(raw.cancellationPolicy, "", raw.cancellationDeadline)).toBe("unknown");
  });
});

it("compares stay totals independently by currency and refundability", () => {
  const flex = makeOffer(raw, stay, "regular")!;
  const prepaid = makeOffer({ ...raw, ratePlanCode: "PREPAY", total: "USD 300", cancellationPolicy: "Non-refundable" }, stay, "regular")!;
  const gov = makeOffer({ ...raw, ratePlanCode: "GOV", ratePlanName: "Government", eligibility: "Government ID and official travel required", total: "USD 350" }, stay, "government")!;
  const cad = makeOffer({ ...raw, currency: "CAD", total: "CAD 1.00", nightly: "CAD 0.50" }, stay, "regular")!;
  const incomplete = makeOffer({ ...raw, total: "USD 1.00", taxesIncluded: false }, stay, "regular")!;
  const comparisons = compareOffers([prepaid, flex, gov, cad, incomplete]);
  const usd = comparisons.find(c => c.currency === "USD")!;
  expect(usd.lowestRefundable.offerId).toBe(gov.offerId);
  expect(usd.lowestGovernment.offerId).toBe(gov.offerId);
  expect(comparisons.find(c => c.currency === "CAD")?.lowestRefundable.offerId).toBe(cad.offerId);
});

it("does not call a regular fallback rate a government offer", () => {
  expect(makeOffer(raw, stay, "government")).toBeUndefined();
  expect(makeOffer({ ...raw, code: "" }, stay, "regular")).toBeUndefined();
});

it("preserves dates, points and every room's occupancy in government searches", () => {
  const query = staySearchParams({ ...stay, rooms: 2, children: 1, usePoints: true }, "government");
  expect(query.get("corporateCode")).toBe("");
  expect(query.get("clusterCode")).toBe("gov");
  expect(query.get("guestCounts[1].numAdults")).toBe("2");
  expect(query.get("guestCounts[1].numChildren")).toBe("1");
  expect(query.get("fromDate")).toBe(stay.checkIn.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1"));
  expect(query.get("toDate")).toBe(stay.checkOut.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1"));
  expect(query.get("flexibleDateSearch")).toBe("false");
  expect(query.get("isFlexibleDatesOptionSelected")).toBe("false");
  expect(query.get("redeemPoints")).toBe("true");
  expect(staySearchParams(stay, "regular").get("corporateCode")).toBe("");
});
