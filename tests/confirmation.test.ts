/**
 * Tests for the confirmation token module.
 *
 * Verifies that confirmation tokens are single-use, time-limited,
 * and action-scoped — preventing prompt-injection bypass of
 * destructive operations.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createConfirmationToken,
  validateConfirmationToken,
  clearPendingConfirmations,
} from "../src/confirmation.js";

afterEach(() => {
  clearPendingConfirmations();
  vi.restoreAllMocks();
});

describe("createConfirmationToken", () => {
  it("returns a hex string token", () => {
    const token = createConfirmationToken("checkout", { hotelId: "NYCMQ" });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns unique tokens each time", () => {
    const t1 = createConfirmationToken("checkout", {});
    const t2 = createConfirmationToken("checkout", {});
    expect(t1).not.toBe(t2);
  });
});

describe("validateConfirmationToken", () => {
  it("validates a correct token and returns data", () => {
    const data = { hotelId: "NYCMQ", checkIn: "2025-07-01" };
    const token = createConfirmationToken("checkout", data);
    const result = validateConfirmationToken(token, "checkout");
    expect(result).toEqual(data);
  });

  it("rejects an invalid token", () => {
    expect(() =>
      validateConfirmationToken("deadbeef00000000deadbeef00000000", "checkout")
    ).toThrow("Invalid or expired confirmation token");
  });

  it("rejects a token used for the wrong action", () => {
    const token = createConfirmationToken("checkout", {});
    expect(() =>
      validateConfirmationToken(token, "cancel_reservation")
    ).toThrow('Confirmation token is for "checkout"');
  });

  it("is single-use — second validation fails", () => {
    const token = createConfirmationToken("checkout", {});

    // First use succeeds
    validateConfirmationToken(token, "checkout");

    // Second use fails
    expect(() =>
      validateConfirmationToken(token, "checkout")
    ).toThrow("Invalid or expired confirmation token");
  });

  it("rejects expired tokens", () => {
    const token = createConfirmationToken("checkout", {});

    // Fast-forward time by 6 minutes (tokens expire in 5)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);

    expect(() =>
      validateConfirmationToken(token, "checkout")
    ).toThrow("expired");
  });
});

describe("clearPendingConfirmations", () => {
  it("invalidates all outstanding tokens", () => {
    const token = createConfirmationToken("checkout", {});
    clearPendingConfirmations();
    expect(() =>
      validateConfirmationToken(token, "checkout")
    ).toThrow("Invalid or expired");
  });
});
