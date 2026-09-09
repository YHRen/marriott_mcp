import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveRateSelections, specialRateValues } from "../src/rate-options.js";
import { makeOffer, offerFingerprint, staySearchParams } from "../src/rates.js";
import { raw, stay } from "./fixtures/marriott.js";
import { SearchHotelsSchema, RoomOptionsSchema } from "../src/validation.js";
import { toolDefinitions } from "../src/tool-definitions.js";

beforeEach(() => {
  for (const key of ["MARRIOTT_SPECIAL_RATES", "MARRIOTT_GOVERNMENT_SCOPE", "MARRIOTT_CORPORATE_CODE"]) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("defaults to regular plus federal government and supports federal-only config", () => {
  expect(resolveRateSelections({})).toEqual([{ rateType: "regular" }, { rateType: "government", governmentScope: "federal" }]);
  vi.stubEnv("MARRIOTT_SPECIAL_RATES", "government");
  expect(resolveRateSelections({})).toEqual([{ rateType: "government", governmentScope: "federal" }]);
});

it("loads multiple configured options in order and lets tools replace defaults", () => {
  vi.stubEnv("MARRIOTT_SPECIAL_RATES", "aaa_caa, senior,corporate_promo");
  vi.stubEnv("MARRIOTT_CORPORATE_CODE", "ABC123");
  expect(resolveRateSelections({})).toEqual([{ rateType: "aaa_caa" }, { rateType: "senior" }, { rateType: "corporate_promo", corporateCode: "ABC123" }]);
  expect(resolveRateSelections({ specialRates: ["regular"] })).toEqual([{ rateType: "regular" }]);
  expect(resolveRateSelections({ specialRates: ["government"], governmentScope: "all" })[0].governmentScope).toBe("all");
  expect(resolveRateSelections({ specialRates: ["corporate_promo"], corporateCode: "XYZ" })[0].corporateCode).toBe("XYZ");
  expect(resolveRateSelections({ rateType: "both" }).map(s => s.rateType)).toEqual(["regular", "government"]);
});

it("rejects invalid/empty/duplicate configuration, missing codes, and conflicting options", () => {
  for (const value of ["", "unknown", "regular,regular", "regular,"]) {
    vi.stubEnv("MARRIOTT_SPECIAL_RATES", value);
    expect(() => resolveRateSelections({})).toThrow();
  }
  expect(() => resolveRateSelections({ specialRates: ["corporate_promo"] })).toThrow();
  expect(() => resolveRateSelections({ specialRates: ["corporate_promo"], corporateCode: "A&B" })).toThrow();
  expect(() => resolveRateSelections({ specialRates: ["regular"], rateType: "both" })).toThrow();
  vi.stubEnv("MARRIOTT_GOVERNMENT_SCOPE", "state");
  expect(() => resolveRateSelections({ specialRates: ["government"] })).toThrow();
});

it("does not silently replace explicitly requested special cash rates in award searches", () => {
  vi.stubEnv("MARRIOTT_SPECIAL_RATES", "government");
  expect(resolveRateSelections({}, true)).toEqual([{ rateType: "regular" }]);
  expect(() => resolveRateSelections({ specialRates: ["government"] }, true)).toThrow("Points searches");
});

it("maps all five observed menu categories without reusing GOV corporate code", () => {
  const expected = ["none", "aaa", "S9R", "gov", "corp"];
  specialRateValues.forEach((rateType, i) => {
    const q = staySearchParams(stay, { rateType, ...(rateType === "corporate_promo" ? { corporateCode: "ABC" } : {}) });
    expect(q.get("clusterCode")).toBe(expected[i]);
    expect(q.get("corporateCode")).toBe(rateType === "corporate_promo" ? "ABC" : "");
    expect(q.get("fromDate")).toBe("07/01/2099");
  });
});

it("keeps state, military-only and ambiguous government offers out of federal-only results", () => {
  const selection = { rateType: "government", governmentScope: "federal" } as const;
  for (const eligibility of ["State government ID required", "Government ID required", "Military ID required", "Non-federal government employees", "Federal government employees not eligible", "State ID required; federal ID not accepted"]) {
    expect(makeOffer({ ...raw, ratePlanName: "Government", eligibility }, stay, selection)).toBeUndefined();
  }
  const offer = makeOffer({ ...raw, ratePlanName: "Govt/military Rate", eligibility: "Federal government ID required" }, stay, selection)!;
  expect(offer.governmentCategory).toBe("federal");
  expect(offer.cancellationPolicy).toBe(raw.cancellationPolicy);
  expect(makeOffer({ ...raw, ratePlanName: "Government State Rate", eligibility: "State government ID required" }, stay, { ...selection, governmentScope: "all" })?.governmentCategory).toBe("state");
});

it("requires special-rate evidence and keeps corporate/promo search identity bound to the quote", () => {
  for (const rateType of ["aaa_caa", "senior", "government"] as const) expect(makeOffer(raw, stay, rateType)).toBeUndefined();
  expect(makeOffer({ ...raw, ratePlanName: "AAA Discount", eligibility: "AAA membership card required" }, stay, "aaa_caa")?.rateType).toBe("aaa_caa");
  expect(makeOffer({ ...raw, ratePlanName: "Senior Discount", eligibility: "Age 62 or older" }, stay, "senior")?.rateType).toBe("senior");
  const corporate = { ...raw, ratePlanName: "Corporate negotiated rate", eligibility: "Company ID required" };
  const selection = { rateType: "corporate_promo", corporateCode: "ABC" } as const;
  expect(makeOffer(corporate, stay, selection)).toBeUndefined();
  expect(makeOffer(raw, stay, selection, true)).toBeUndefined();
  const offer = makeOffer(corporate, stay, selection, true)!;
  expect(offerFingerprint(offer)).not.toBe(offerFingerprint({ ...offer, requestedSelection: { ...selection, corporateCode: "XYZ" } }));
});

it("exposes and validates every option in both MCP search tools", () => {
  for (const name of ["search_hotels", "get_room_options"]) {
    const props = toolDefinitions.find(t => t.name === name)!.inputSchema.properties!;
    for (const key of ["specialRates", "governmentScope", "corporateCode"]) expect(props).toHaveProperty(key);
  }
  const search = { destination: "Lemont", checkIn: "2026-10-14", checkOut: "2026-10-16" };
  expect(SearchHotelsSchema.parse({ ...search, specialRates: [...specialRateValues], corporateCode: "ABC" }).specialRates).toHaveLength(5);
  expect(() => SearchHotelsSchema.parse({ ...search, specialRates: [] })).toThrow();
  expect(() => RoomOptionsSchema.parse({ ...stay, specialRates: ["government"], rateType: "government" })).toThrow();
});
