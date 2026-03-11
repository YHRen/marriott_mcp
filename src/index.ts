#!/usr/bin/env node

/**
 * Strider Labs Marriott MCP Server
 *
 * MCP server that gives AI agents the ability to search Marriott hotels,
 * manage reservations, check in, and interact with the Bonvoy loyalty program
 * via browser automation.
 * https://striderlabs.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  checkLoginStatus,
  initiateLogin,
  searchHotels,
  getHotelDetails,
  getRoomOptions,
  selectRoom,
  addExtras,
  checkout,
  getReservation,
  modifyReservation,
  cancelReservation,
  checkIn,
  getBonvoyStatus,
  redeemPoints,
  getStayHistory,
  closeBrowser,
} from "./browser.js";
import { loadSessionInfo, clearAuthData, getConfigDir } from "./auth.js";

// Initialize server
const server = new Server(
  {
    name: "strider-marriott",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "status",
        description:
          "Check Marriott login status and Bonvoy session info. Use this to verify authentication before performing other actions.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "login",
        description:
          "Log in to Marriott Bonvoy. Reads MARRIOTT_EMAIL and MARRIOTT_PASSWORD from environment variables, or returns a URL for manual login.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "logout",
        description:
          "Clear saved Marriott session and cookies. Use this to log out or reset authentication state.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_hotels",
        description:
          "Search for Marriott hotels by destination and dates. Returns hotel names, brands, ratings, locations, and nightly rates.",
        inputSchema: {
          type: "object",
          properties: {
            destination: {
              type: "string",
              description:
                "Destination city or area (e.g., 'New York, NY', 'Paris, France', 'Miami Beach')",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format (e.g., '2025-07-01')",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format (e.g., '2025-07-07')",
            },
            adults: {
              type: "number",
              description: "Number of adults per room (default: 1)",
            },
            children: {
              type: "number",
              description: "Number of children (default: 0)",
            },
            rooms: {
              type: "number",
              description: "Number of rooms (default: 1)",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (default: 10, max: 50)",
            },
          },
          required: ["destination", "checkIn", "checkOut"],
        },
      },
      {
        name: "get_hotel_details",
        description:
          "Get detailed information about a specific Marriott hotel — description, amenities, policies, check-in/out times, parking, and pet policy.",
        inputSchema: {
          type: "object",
          properties: {
            hotelIdOrUrl: {
              type: "string",
              description:
                "Hotel property code (e.g., 'NYCMQ') or full URL from search_hotels results",
            },
          },
          required: ["hotelIdOrUrl"],
        },
      },
      {
        name: "get_room_options",
        description:
          "View available room types and rates for a specific hotel and date range. Returns room names, bed types, prices, cancellation policies, and Bonvoy point rates.",
        inputSchema: {
          type: "object",
          properties: {
            hotelId: {
              type: "string",
              description: "Hotel property code (e.g., 'NYCMQ') from search_hotels results",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 1)",
            },
            children: {
              type: "number",
              description: "Number of children (default: 0)",
            },
            usePoints: {
              type: "boolean",
              description: "Show points-redemption rates (default: false)",
            },
          },
          required: ["hotelId", "checkIn", "checkOut"],
        },
      },
      {
        name: "select_room",
        description:
          "Choose a room type to book. Call this after get_room_options to select a room before checkout.",
        inputSchema: {
          type: "object",
          properties: {
            hotelId: {
              type: "string",
              description: "Hotel property code",
            },
            roomCode: {
              type: "string",
              description: "Room type code from get_room_options",
            },
            ratePlanCode: {
              type: "string",
              description: "Rate plan code from get_room_options (optional)",
            },
          },
          required: ["hotelId", "roomCode"],
        },
      },
      {
        name: "add_extras",
        description:
          "Add optional extras to your booking — parking, breakfast, late checkout, early check-in, airport transfer, or spa credit.",
        inputSchema: {
          type: "object",
          properties: {
            extras: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "parking",
                  "breakfast",
                  "late_checkout",
                  "early_checkin",
                  "airport_transfer",
                  "spa_credit",
                ],
              },
              description: "List of extras to add",
            },
          },
          required: ["extras"],
        },
      },
      {
        name: "checkout",
        description:
          "Complete a Marriott hotel booking. IMPORTANT: Set confirm=true only after getting explicit user confirmation. Without confirm=true, returns a booking preview instead of charging.",
        inputSchema: {
          type: "object",
          properties: {
            hotelId: {
              type: "string",
              description: "Hotel property code (optional if select_room was called)",
            },
            roomCode: {
              type: "string",
              description: "Room type code (optional if select_room was called)",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 1)",
            },
            children: {
              type: "number",
              description: "Number of children (default: 0)",
            },
            firstName: {
              type: "string",
              description: "Guest first name",
            },
            lastName: {
              type: "string",
              description: "Guest last name",
            },
            email: {
              type: "string",
              description: "Confirmation email address",
            },
            phone: {
              type: "string",
              description: "Guest phone number",
            },
            specialRequests: {
              type: "string",
              description: "Special requests for the hotel",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to complete the booking. If false or omitted, returns a preview only. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["checkIn", "checkOut"],
        },
      },
      {
        name: "get_reservation",
        description:
          "Retrieve existing Marriott reservation details. Requires being logged in. Returns upcoming reservations or a specific booking by confirmation number.",
        inputSchema: {
          type: "object",
          properties: {
            confirmationNumber: {
              type: "string",
              description:
                "Optional confirmation number to retrieve a specific reservation. Omit to get all upcoming reservations.",
            },
          },
        },
      },
      {
        name: "modify_reservation",
        description:
          "Change dates or room type for an existing reservation. IMPORTANT: Set confirm=true only after getting explicit user confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            confirmationNumber: {
              type: "string",
              description: "Reservation confirmation number",
            },
            newCheckIn: {
              type: "string",
              description: "New check-in date in YYYY-MM-DD format",
            },
            newCheckOut: {
              type: "string",
              description: "New check-out date in YYYY-MM-DD format",
            },
            newRoomType: {
              type: "string",
              description: "New room type code",
            },
            specialRequests: {
              type: "string",
              description: "Updated special requests",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to apply the modification. If false or omitted, returns a preview. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["confirmationNumber"],
        },
      },
      {
        name: "cancel_reservation",
        description:
          "Cancel an existing Marriott reservation. IMPORTANT: Set confirm=true only after getting explicit user confirmation. Cancellation fees may apply.",
        inputSchema: {
          type: "object",
          properties: {
            confirmationNumber: {
              type: "string",
              description: "Reservation confirmation number to cancel",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to confirm cancellation. If false or omitted, returns a preview. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["confirmationNumber"],
        },
      },
      {
        name: "check_in",
        description:
          "Complete mobile check-in for an upcoming Marriott reservation. May return room number and mobile key availability.",
        inputSchema: {
          type: "object",
          properties: {
            confirmationNumber: {
              type: "string",
              description: "Reservation confirmation number",
            },
            estimatedArrivalTime: {
              type: "string",
              description: "Estimated arrival time (e.g., '3:00 PM')",
            },
            roomPreferences: {
              type: "string",
              description: "Room preferences (e.g., 'high floor, away from elevator')",
            },
          },
          required: ["confirmationNumber"],
        },
      },
      {
        name: "get_bonvoy_status",
        description:
          "Check Marriott Bonvoy loyalty program status — points balance, membership tier, nights this year, progress to next tier, and recent activity. Requires being logged in.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "redeem_points",
        description:
          "Book a hotel stay using Marriott Bonvoy points. Shows available award rates. IMPORTANT: Set confirm=true only after getting explicit user confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            hotelId: {
              type: "string",
              description: "Hotel property code",
            },
            checkIn: {
              type: "string",
              description: "Check-in date in YYYY-MM-DD format",
            },
            checkOut: {
              type: "string",
              description: "Check-out date in YYYY-MM-DD format",
            },
            adults: {
              type: "number",
              description: "Number of adults (default: 1)",
            },
            roomCode: {
              type: "string",
              description:
                "Specific room code to redeem. Omit to use the lowest-points option.",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to complete the points redemption. If false or omitted, returns available award rates. NEVER set to true without explicit user confirmation.",
            },
          },
          required: ["hotelId", "checkIn", "checkOut"],
        },
      },
      {
        name: "get_stay_history",
        description:
          "View past Marriott stays including dates, hotels, points earned, and costs. Requires being logged in.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of past stays to return (default: 20)",
            },
          },
        },
      },
    ],
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "status": {
        const sessionInfo = loadSessionInfo();
        const liveStatus = await checkLoginStatus();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  session: liveStatus,
                  savedSession: sessionInfo,
                  configDir: getConfigDir(),
                  message: liveStatus.isLoggedIn
                    ? `Logged in${
                        liveStatus.userName
                          ? ` as ${liveStatus.userName}`
                          : liveStatus.userEmail
                          ? ` as ${liveStatus.userEmail}`
                          : ""
                      }${liveStatus.bonvoyTier ? ` (${liveStatus.bonvoyTier})` : ""}`
                    : "Not logged in. Use login to authenticate, or set MARRIOTT_EMAIL and MARRIOTT_PASSWORD environment variables.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "login": {
        const result = await initiateLogin();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "logout": {
        clearAuthData();
        await closeBrowser();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Logged out. Session and cookies cleared.",
              }),
            },
          ],
        };
      }

      case "search_hotels": {
        const {
          destination,
          checkIn,
          checkOut,
          adults,
          children,
          rooms,
          maxResults = 10,
        } = args as {
          destination: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          children?: number;
          rooms?: number;
          maxResults?: number;
        };

        const hotels = await searchHotels({
          destination,
          checkIn,
          checkOut,
          adults,
          children,
          rooms,
          maxResults: Math.min(maxResults, 50),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  destination,
                  checkIn,
                  checkOut,
                  count: hotels.length,
                  hotels,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_hotel_details": {
        const { hotelIdOrUrl } = args as { hotelIdOrUrl: string };
        const details = await getHotelDetails(hotelIdOrUrl);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  details,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_room_options": {
        const {
          hotelId,
          checkIn,
          checkOut,
          adults,
          children,
          usePoints,
        } = args as {
          hotelId: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          children?: number;
          usePoints?: boolean;
        };

        const rooms = await getRoomOptions({
          hotelId,
          checkIn,
          checkOut,
          adults,
          children,
          usePoints,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  hotelId,
                  checkIn,
                  checkOut,
                  count: rooms.length,
                  rooms,
                  tip: "Use select_room with a roomCode to choose a room before checkout.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "select_room": {
        const { hotelId, roomCode, ratePlanCode } = args as {
          hotelId: string;
          roomCode: string;
          ratePlanCode?: string;
        };

        const result = await selectRoom({ hotelId, roomCode, ratePlanCode });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "add_extras": {
        const { extras } = args as {
          extras: Array<
            | "parking"
            | "breakfast"
            | "late_checkout"
            | "early_checkin"
            | "airport_transfer"
            | "spa_credit"
          >;
        };

        const result = await addExtras({ extras });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "checkout": {
        const {
          hotelId,
          roomCode,
          checkIn,
          checkOut,
          adults,
          children,
          firstName,
          lastName,
          email,
          phone,
          specialRequests,
          confirm = false,
        } = args as {
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
        };

        const result = await checkout({
          hotelId,
          roomCode,
          checkIn,
          checkOut,
          adults,
          children,
          firstName,
          lastName,
          email,
          phone,
          specialRequests,
          confirm,
        });

        if ("requiresConfirmation" in result) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    preview: result.preview,
                    note: "Call checkout with confirm=true to complete the booking. IMPORTANT: Only do this after getting explicit user confirmation.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: result.success,
                  confirmationNumber: result.confirmationNumber,
                  message: result.message,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_reservation": {
        const { confirmationNumber } = (args as { confirmationNumber?: string }) || {};
        const reservations = await getReservation(confirmationNumber);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  count: reservations.length,
                  reservations,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "modify_reservation": {
        const {
          confirmationNumber,
          newCheckIn,
          newCheckOut,
          newRoomType,
          specialRequests,
          confirm = false,
        } = args as {
          confirmationNumber: string;
          newCheckIn?: string;
          newCheckOut?: string;
          newRoomType?: string;
          specialRequests?: string;
          confirm?: boolean;
        };

        const result = await modifyReservation({
          confirmationNumber,
          newCheckIn,
          newCheckOut,
          newRoomType,
          specialRequests,
          confirm,
        });

        if ("requiresConfirmation" in result) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    preview: result.preview,
                    note: "Call modify_reservation with confirm=true to apply changes. IMPORTANT: Only do this after explicit user confirmation.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "cancel_reservation": {
        const { confirmationNumber, confirm = false } = args as {
          confirmationNumber: string;
          confirm?: boolean;
        };

        const result = await cancelReservation({ confirmationNumber, confirm });

        if ("requiresConfirmation" in result) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    preview: result.preview,
                    note: "Call cancel_reservation with confirm=true to cancel. IMPORTANT: Only do this after explicit user confirmation. This cannot be undone.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "check_in": {
        const { confirmationNumber, estimatedArrivalTime, roomPreferences } = args as {
          confirmationNumber: string;
          estimatedArrivalTime?: string;
          roomPreferences?: string;
        };

        const result = await checkIn({
          confirmationNumber,
          estimatedArrivalTime,
          roomPreferences,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_bonvoy_status": {
        const status = await getBonvoyStatus();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  bonvoyStatus: status,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "redeem_points": {
        const { hotelId, checkIn, checkOut, adults, roomCode, confirm = false } = args as {
          hotelId: string;
          checkIn: string;
          checkOut: string;
          adults?: number;
          roomCode?: string;
          confirm?: boolean;
        };

        const result = await redeemPoints({
          hotelId,
          checkIn,
          checkOut,
          adults,
          roomCode,
          confirm,
        });

        if ("requiresConfirmation" in result) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    preview: result.preview,
                    note: "Call redeem_points with confirm=true to complete redemption. IMPORTANT: Only do this after explicit user confirmation.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_stay_history": {
        const { limit } = (args as { limit?: number }) || {};
        const history = await getStayHistory({ limit });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...history,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
              suggestion:
                errorMessage.toLowerCase().includes("login") ||
                errorMessage.toLowerCase().includes("auth") ||
                errorMessage.toLowerCase().includes("signin")
                  ? "Use the login tool to authenticate, or set MARRIOTT_EMAIL and MARRIOTT_PASSWORD environment variables."
                  : errorMessage.toLowerCase().includes("captcha")
                  ? "CAPTCHA encountered. Try again in a moment or complete login manually."
                  : errorMessage.toLowerCase().includes("timeout")
                  ? "The page took too long to load. Try again."
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// Cleanup on server close
server.onclose = async () => {
  await closeBrowser();
};

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Strider Marriott MCP server running");
  console.error(`Config directory: ${getConfigDir()}`);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
