import { z } from "zod";

export const specialRateValues = ["regular", "aaa_caa", "senior", "government", "corporate_promo"] as const;
export type SpecialRate = typeof specialRateValues[number];
export const specialRatesSchema = z.array(z.enum(specialRateValues)).min(1).max(5)
  .refine(values => new Set(values).size === values.length, "Special rates must not contain duplicates.");
export const corporateCodeSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,20}$/, "Use a 2–20 character alphanumeric corporate/promo code.");
export const governmentScopeSchema = z.enum(["federal", "all"]);
export const rateOptionFields = {
  specialRates: specialRatesSchema.optional().describe("Categories to search separately. Overrides MARRIOTT_SPECIAL_RATES. All matching offers and cancellation terms are returned; none is selected automatically."),
  corporateCode: corporateCodeSchema.optional().describe("Required for corporate_promo, or set MARRIOTT_CORPORATE_CODE."),
  governmentScope: governmentScopeSchema.optional().describe("federal (default) excludes state-only and unverified government eligibility; all includes all verified government/military categories."),
  rateType: z.enum(["regular", "government", "both"]).optional().describe("Deprecated alias. Do not combine with specialRates."),
};
export interface RateOptions {
  specialRates?: SpecialRate[];
  corporateCode?: string;
  governmentScope?: "federal" | "all";
  rateType?: "regular" | "government" | "both";
}
export interface RateSelection {
  rateType: SpecialRate;
  corporateCode?: string;
  governmentScope?: "federal" | "all";
}

/** Validate before any browser work. Explicit tool options replace config defaults. */
export function resolveRateSelections(options: RateOptions, usePoints = false): RateSelection[] {
  if (options.specialRates && options.rateType) throw new Error("Provide specialRates or legacy rateType, not both.");
  const explicit = options.specialRates ?? (options.rateType ? options.rateType === "both" ? ["regular", "government"] : [options.rateType] : undefined);
  const rates = specialRatesSchema.parse(explicit ?? (usePoints ? ["regular"] : process.env.MARRIOTT_SPECIAL_RATES?.split(",").map(s => s.trim()) ?? ["regular", "government"]));
  if (usePoints && (rates.length !== 1 || rates[0] !== "regular")) throw new Error("Points searches support only regular award inventory; special cash rates cannot be combined with usePoints.");
  const scope = rates.includes("government") ? governmentScopeSchema.parse(options.governmentScope ?? process.env.MARRIOTT_GOVERNMENT_SCOPE ?? "federal") : undefined;
  let code: string | undefined;
  if (rates.includes("corporate_promo")) {
    const parsed = corporateCodeSchema.safeParse(options.corporateCode ?? process.env.MARRIOTT_CORPORATE_CODE);
    if (!parsed.success) throw new Error("corporate_promo requires a 2–20 character alphanumeric corporateCode or MARRIOTT_CORPORATE_CODE.");
    code = parsed.data;
  }
  return rates.map(rateType => ({ rateType, ...(rateType === "government" ? { governmentScope: scope } : {}), ...(rateType === "corporate_promo" ? { corporateCode: code } : {}) }));
}

export function selectionFrom(value: SpecialRate | RateSelection): RateSelection {
  return typeof value === "string" ? { rateType: value } : value;
}
