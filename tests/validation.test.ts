/**
 * Tests for the input validation module.
 *
 * These tests verify that the Zod schemas correctly accept valid inputs
 * and reject malicious/malformed inputs — the first line of defense
 * against injection attacks.
 */

import { describe, it, expect } from "vitest";
import {
  SearchHotelsSchema,
  HotelDetailsSchema,
  RoomOptionsSchema,
  SelectRoomSchema,
  AddExtrasSchema,
  CheckoutSchema,
  GetReservationSchema,
  ModifyReservationSchema,
  CancelReservationSchema,
  CheckInSchema,
  RedeemPointsSchema,
  StayHistorySchema,
} from "../src/validation.js";

// ─── SearchHotelsSchema ─────────────────────────────────────────────────────

describe("SearchHotelsSchema", () => {
  it("accepts valid search parameters", () => {
    const result = SearchHotelsSchema.parse({
      destination: "New York, NY",
      checkIn: "2025-07-01",
      checkOut: "2025-07-05",
      adults: 2,
      children: 1,
      rooms: 1,
      maxResults: 10,
    });
    expect(result.destination).toBe("New York, NY");
  });

  it("accepts minimal required fields", () => {
    const result = SearchHotelsSchema.parse({
      destination: "Tokyo",
      checkIn: "2025-08-01",
      checkOut: "2025-08-03",
    });
    expect(result.destination).toBe("Tokyo");
  });

  it("rejects invalid date format", () => {
    expect(() =>
      SearchHotelsSchema.parse({
        destination: "Paris",
        checkIn: "July 1, 2025",
        checkOut: "2025-07-05",
      })
    ).toThrow();
  });

  it("rejects checkIn after checkOut", () => {
    expect(() =>
      SearchHotelsSchema.parse({
        destination: "London",
        checkIn: "2025-07-10",
        checkOut: "2025-07-05",
      })
    ).toThrow("checkIn must be before checkOut");
  });

  it("rejects negative adults", () => {
    expect(() =>
      SearchHotelsSchema.parse({
        destination: "Miami",
        checkIn: "2025-07-01",
        checkOut: "2025-07-03",
        adults: -1,
      })
    ).toThrow();
  });

  it("rejects excessively large maxResults", () => {
    expect(() =>
      SearchHotelsSchema.parse({
        destination: "Miami",
        checkIn: "2025-07-01",
        checkOut: "2025-07-03",
        maxResults: 1000,
      })
    ).toThrow();
  });

  it("rejects very long destination string", () => {
    expect(() =>
      SearchHotelsSchema.parse({
        destination: "A".repeat(300),
        checkIn: "2025-07-01",
        checkOut: "2025-07-03",
      })
    ).toThrow();
  });
});

// ─── HotelDetailsSchema ─────────────────────────────────────────────────────

describe("HotelDetailsSchema", () => {
  it("accepts a valid hotel ID", () => {
    const result = HotelDetailsSchema.parse({ hotelIdOrUrl: "NYCMQ" });
    expect(result.hotelIdOrUrl).toBe("NYCMQ");
  });

  it("accepts a valid marriott.com URL", () => {
    const result = HotelDetailsSchema.parse({
      hotelIdOrUrl: "https://www.marriott.com/hotels/hotel-overview/NYCMQ.mi",
    });
    expect(result.hotelIdOrUrl).toContain("marriott.com");
  });

  it("rejects a non-marriott URL (SSRF attempt)", () => {
    expect(() =>
      HotelDetailsSchema.parse({
        hotelIdOrUrl: "https://evil.com/phishing",
      })
    ).toThrow();
  });

  it("rejects an internal network URL (SSRF attempt)", () => {
    expect(() =>
      HotelDetailsSchema.parse({
        hotelIdOrUrl: "http://169.254.169.254/latest/meta-data/",
      })
    ).toThrow();
  });

  it("rejects localhost URL", () => {
    expect(() =>
      HotelDetailsSchema.parse({
        hotelIdOrUrl: "https://localhost:8080/admin",
      })
    ).toThrow();
  });

  it("rejects hotel ID with special characters (injection attempt)", () => {
    expect(() =>
      HotelDetailsSchema.parse({
        hotelIdOrUrl: "NYCMQ&redirect=https://evil.com",
      })
    ).toThrow();
  });

  it("rejects HTTP (non-HTTPS) marriott URL", () => {
    expect(() =>
      HotelDetailsSchema.parse({
        hotelIdOrUrl: "http://www.marriott.com/hotels/hotel-overview/NYCMQ.mi",
      })
    ).toThrow();
  });
});

// ─── CheckoutSchema ─────────────────────────────────────────────────────────

describe("CheckoutSchema", () => {
  it("accepts valid checkout data", () => {
    const result = CheckoutSchema.parse({
      checkIn: "2025-07-01",
      checkOut: "2025-07-05",
      hotelId: "NYCMQ",
      roomCode: "STD",
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
      phone: "+1 (212) 555-1234",
    });
    expect(result.firstName).toBe("John");
  });

  it("rejects invalid email format", () => {
    expect(() =>
      CheckoutSchema.parse({
        checkIn: "2025-07-01",
        checkOut: "2025-07-05",
        email: "not-an-email",
      })
    ).toThrow();
  });

  it("rejects invalid phone format", () => {
    expect(() =>
      CheckoutSchema.parse({
        checkIn: "2025-07-01",
        checkOut: "2025-07-05",
        phone: "DROP TABLE users;",
      })
    ).toThrow();
  });
});

// ─── CancelReservationSchema ────────────────────────────────────────────────

describe("CancelReservationSchema", () => {
  it("accepts valid confirmation number", () => {
    const result = CancelReservationSchema.parse({
      confirmationNumber: "ABC12345",
    });
    expect(result.confirmationNumber).toBe("ABC12345");
  });

  it("rejects confirmation number with query injection", () => {
    expect(() =>
      CancelReservationSchema.parse({
        confirmationNumber: "ABC123&redirect=https://evil.com",
      })
    ).toThrow();
  });

  it("rejects confirmation number with path traversal", () => {
    expect(() =>
      CancelReservationSchema.parse({
        confirmationNumber: "../../../etc/passwd",
      })
    ).toThrow();
  });

  it("rejects empty confirmation number", () => {
    expect(() =>
      CancelReservationSchema.parse({
        confirmationNumber: "",
      })
    ).toThrow();
  });
});

// ─── AddExtrasSchema ────────────────────────────────────────────────────────

describe("AddExtrasSchema", () => {
  it("accepts valid extras", () => {
    const result = AddExtrasSchema.parse({
      extras: ["parking", "breakfast"],
    });
    expect(result.extras).toHaveLength(2);
  });

  it("rejects invalid extra type", () => {
    expect(() =>
      AddExtrasSchema.parse({
        extras: ["hacking"],
      })
    ).toThrow();
  });

  it("rejects empty extras array", () => {
    expect(() =>
      AddExtrasSchema.parse({
        extras: [],
      })
    ).toThrow();
  });
});

// ─── StayHistorySchema ──────────────────────────────────────────────────────

describe("StayHistorySchema", () => {
  it("accepts valid limit", () => {
    const result = StayHistorySchema.parse({ limit: 20 });
    expect(result.limit).toBe(20);
  });

  it("rejects negative limit", () => {
    expect(() => StayHistorySchema.parse({ limit: -5 })).toThrow();
  });

  it("rejects limit over 100", () => {
    expect(() => StayHistorySchema.parse({ limit: 500 })).toThrow();
  });
});
