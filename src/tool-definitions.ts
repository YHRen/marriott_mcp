import { z } from "zod";
import {
  SearchHotelsSchema, HotelDetailsSchema, RoomOptionsSchema, SelectRoomSchema,
  AddExtrasSchema, CheckoutSchema, GetReservationSchema, ModifyReservationSchema,
  CancelReservationSchema, CheckInSchema, RedeemPointsSchema, StayHistorySchema,
} from "./validation.js";

const definitions = [
  ["status", "Verify authentication. Launched sessions save cookies; attached Chrome sessions keep cookies in Chrome without exporting them.", z.object({})],
  ["login", "Open the server browser for manual Marriott login; optionally use credentials from the server environment. Finish with status.", z.object({})],
  ["recover_session", "Bring the same server browser forward to complete a challenge or login. Requires headed mode, which is the default.", z.object({})],
  ["logout", "Clear MCP authentication, pending confirmations and selected offers. An attached Chrome profile is disconnected and stays signed in; sign out in Chrome separately. Booking-attempt journal is retained.", z.object({})],
  ["search_hotels", "Search each selected specialRates category (or MCP environment defaults) and return all matching offers, grouped by category, with cancellation/deposit terms and eligibility. Government scope defaults to federal-only. Unknown categories are not sold out. No winner is selected: present the options to the user before select_room or checkout. Adults/children are per room.", SearchHotelsSchema],
  ["get_hotel_details", "Get property details for a Marriott property code or URL.", HotelDetailsSchema],
  ["get_room_options", "Return all matching room/rate offers grouped in rateResults for each selected specialRates category, with cancellation policy, deadline, deposit terms and eligibility. Defaults come from MCP environment config; government scope defaults to federal-only. No rate is automatically selected or ranked. Missing terms remain unknown. usePoints supports only regular award inventory. Review options with the user before choosing an offerId.", RoomOptionsSchema],
  ["select_room", "Select an exact offerId from search results. Legacy room codes require an unambiguous ratePlanCode. Does not submit a reservation.", SelectRoomSchema],
  ["add_extras", "Extras are not supported by this adapter. This tool reports that nothing was added.", AddExtrasSchema],
  ["checkout", "Prepare a verified checkout preview for the selected offerId. Review total, terms and guest details with the user. Only after explicit user approval call again with the returned confirmationToken. A token-only call uses the saved parameters. Changed price/terms require new approval. Government offers require governmentEligibilityConfirmed; other special rates require specialRateEligibilityConfirmed. Never retry an unknown submission outcome.", CheckoutSchema],
  ["get_reservation", "Read upcoming Marriott reservations or filter by confirmation number.", GetReservationSchema],
  ["modify_reservation", "Preview reservation changes. After explicit user approval, repeat identical parameters with confirmationToken. Changed parameters require a new preview.", ModifyReservationSchema],
  ["cancel_reservation", "Preview a cancellation. After explicit user approval, repeat the same confirmationNumber with confirmationToken.", CancelReservationSchema],
  ["check_in", "Request mobile check-in for an existing reservation.", CheckInSchema],
  ["get_bonvoy_status", "Read Marriott Bonvoy points and tier status.", z.object({})],
  ["redeem_points", "Preview and book an exact award offer from a usePoints search. Only after explicit user approval pass confirmationToken. Never retry an unknown submission outcome.", RedeemPointsSchema],
  ["get_stay_history", "Read past stays.", StayHistorySchema],
] as const;

/** One schema source prevents advertised tools drifting from runtime validation. */
export const toolDefinitions = definitions.map(([name, description, schema]) => ({
  name, description,
  inputSchema: z.toJSONSchema(schema, { target: "draft-7" }),
}));
