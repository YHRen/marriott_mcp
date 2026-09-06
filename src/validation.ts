/**
 * Strider Labs - Input Validation
 *
 * Zod schemas for all MCP tool inputs. Provides runtime validation
 * to prevent injection attacks and malformed data.
 */

import { z } from "zod";

// ─── Reusable Primitives ────────────────────────────────────────────────────

const dateFormat = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine((d) => !isNaN(Date.parse(d)), "Invalid date value");

const hotelId = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[A-Za-z0-9]+$/, "Hotel ID must be alphanumeric");

const marriottUrl = z
  .string()
  .url("Must be a valid URL")
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        (parsed.hostname === "www.marriott.com" ||
          parsed.hostname === "marriott.com" ||
          parsed.hostname.endsWith(".marriott.com"))
      );
    } catch {
      return false;
    }
  }, "URL must be an HTTPS URL on marriott.com");

const confirmationNumber = z
  .string()
  .min(4)
  .max(20)
  .regex(/^[A-Za-z0-9]+$/, "Confirmation number must be alphanumeric");

const safeString = (max = 500) => z.string().max(max);

const positiveInt = (max: number) => z.number().int().min(1).max(max);

const nonNegativeInt = (max: number) => z.number().int().min(0).max(max);

// ─── Tool Schemas ───────────────────────────────────────────────────────────

export const SearchHotelsSchema = z
  .object({
    destination: safeString(200),
    checkIn: dateFormat,
    checkOut: dateFormat,
    adults: positiveInt(10).optional(),
    children: nonNegativeInt(10).optional(),
    rooms: positiveInt(9).optional(),
    maxResults: positiveInt(50).optional(),
  })
  .refine((d) => d.checkIn < d.checkOut, {
    message: "checkIn must be before checkOut",
  });

export const HotelDetailsSchema = z.object({
  hotelIdOrUrl: z.union([hotelId, marriottUrl]),
});

export const RoomOptionsSchema = z
  .object({
    hotelId,
    checkIn: dateFormat,
    checkOut: dateFormat,
    adults: positiveInt(10).optional(),
    children: nonNegativeInt(10).optional(),
    usePoints: z.boolean().optional(),
  })
  .refine((d) => d.checkIn < d.checkOut, {
    message: "checkIn must be before checkOut",
  });

export const SelectRoomSchema = z.object({
  hotelId,
  roomCode: safeString(30),
  ratePlanCode: safeString(30).optional(),
});

const extraTypes = z.enum([
  "parking",
  "breakfast",
  "late_checkout",
  "early_checkin",
  "airport_transfer",
  "spa_credit",
]);

export const AddExtrasSchema = z.object({
  extras: z.array(extraTypes).min(1).max(10),
});

export const CheckoutSchema = z
  .object({
    hotelId: hotelId.optional(),
    roomCode: safeString(30).optional(),
    checkIn: dateFormat,
    checkOut: dateFormat,
    adults: positiveInt(10).optional(),
    children: nonNegativeInt(10).optional(),
    firstName: safeString(100).optional(),
    lastName: safeString(100).optional(),
    email: z.string().email("Invalid email format").optional(),
    phone: z
      .string()
      .regex(/^[0-9+\-() ]{7,20}$/, "Invalid phone number format")
      .optional(),
    specialRequests: safeString(1000).optional(),
    confirm: z.boolean().optional(),
    confirmationToken: safeString(64).optional(),
  })
  .refine((d) => d.checkIn < d.checkOut, {
    message: "checkIn must be before checkOut",
  });

export const GetReservationSchema = z.object({
  confirmationNumber: confirmationNumber.optional(),
});

export const ModifyReservationSchema = z.object({
  confirmationNumber,
  newCheckIn: dateFormat.optional(),
  newCheckOut: dateFormat.optional(),
  newRoomType: safeString(30).optional(),
  specialRequests: safeString(1000).optional(),
  confirm: z.boolean().optional(),
  confirmationToken: safeString(64).optional(),
});

export const CancelReservationSchema = z.object({
  confirmationNumber,
  confirm: z.boolean().optional(),
  confirmationToken: safeString(64).optional(),
});

export const CheckInSchema = z.object({
  confirmationNumber,
  estimatedArrivalTime: safeString(20).optional(),
  roomPreferences: safeString(500).optional(),
});

export const RedeemPointsSchema = z
  .object({
    hotelId,
    checkIn: dateFormat,
    checkOut: dateFormat,
    adults: positiveInt(10).optional(),
    roomCode: safeString(30).optional(),
    confirm: z.boolean().optional(),
    confirmationToken: safeString(64).optional(),
  })
  .refine((d) => d.checkIn < d.checkOut, {
    message: "checkIn must be before checkOut",
  });

export const StayHistorySchema = z.object({
  limit: positiveInt(100).optional(),
});
