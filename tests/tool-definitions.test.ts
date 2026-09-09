import { expect, it } from "vitest";
import { toolDefinitions } from "../src/tool-definitions.js";
import { CheckoutSchema, SearchHotelsSchema } from "../src/validation.js";

it("advertises the same confirmation API enforced at runtime", () => {
  for (const name of ["checkout", "redeem_points", "modify_reservation", "cancel_reservation"]) {
    const tool = toolDefinitions.find(t => t.name === name)!;
    expect(tool.inputSchema.properties).toHaveProperty("confirmationToken");
    expect(tool.inputSchema.properties).not.toHaveProperty("confirm");
  }
  expect(CheckoutSchema.parse({ confirmationToken: "abc" })).toEqual({ confirmationToken: "abc" });
  expect(() => CheckoutSchema.parse({ confirm: true })).toThrow();
  expect(toolDefinitions.find(t => t.name === "search_hotels")?.inputSchema.properties).toHaveProperty("rateType");
});

it("rejects normalized impossible dates and blank destinations", () => {
  expect(() => SearchHotelsSchema.parse({ destination: "Boston", checkIn: "2027-02-30", checkOut: "2027-03-05" })).toThrow();
  expect(() => SearchHotelsSchema.parse({ destination: "  ", checkIn: "2099-02-01", checkOut: "2099-02-02" })).toThrow();
});
