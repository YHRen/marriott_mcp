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
import { ZodError } from "zod";
import { toolDefinitions } from "./tool-definitions.js";
import { MarriottPageError } from "./page-state.js";

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
  recoverSession,
  logoutBrowser,
} from "./browser.js";
import { loadSessionInfo } from "./secure-store.js";
import {
  createConfirmationToken,
  validateConfirmationToken,
} from "./confirmation.js";
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
} from "./validation.js";

/**
 * Sanitize error messages to prevent information leakage.
 * Strips URLs (which may contain tokens) and maps known errors
 * to user-friendly messages.
 */
function sanitizeError(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return `Invalid input: ${issues.join("; ")}`;
  }

  const msg = error instanceof Error ? error.message : String(error);

  // Strip URLs that might contain session tokens or internal paths
  const sanitized = msg.replace(/https?:\/\/[^\s]+/g, "[URL redacted]");

  // Map known Playwright / network errors to friendly messages
  if (msg.includes("net::ERR_")) return "Network error. Please try again.";
  if (msg.includes("Timeout") || msg.includes("timeout"))
    return "The page took too long to load. Please try again.";
  if (msg.toLowerCase().includes("captcha"))
    return "CAPTCHA detected. Try again later or log in manually.";

  return sanitized;
}

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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "status": {
        const sessionInfo = process.env.MARRIOTT_CDP_URL ? null : loadSessionInfo();
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

      case "recover_session": {
        const result = await recoverSession();
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "logout": {
        const result = await logoutBrowser();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      }

      case "search_hotels": {
        const result = await searchHotels(SearchHotelsSchema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      }

      case "get_hotel_details": {
        const { hotelIdOrUrl } = HotelDetailsSchema.parse(args);
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
        const result = await getRoomOptions(RoomOptionsSchema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      }

      case "select_room": {
        const result = await selectRoom(SelectRoomSchema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_extras": {
        const { extras } = AddExtrasSchema.parse(args);

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
        const result = await checkout(CheckoutSchema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.success };
      }

      case "get_reservation": {
        const { confirmationNumber } = GetReservationSchema.parse(args || {});
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
        const validated = ModifyReservationSchema.parse(args);
        const {
          confirmationNumber,
          newCheckIn,
          newCheckOut,
          newRoomType,
          specialRequests,
          confirmationToken,
        } = validated;

        if (confirmationToken) {
          validateConfirmationToken(confirmationToken, "modify_reservation", { confirmationNumber, newCheckIn, newCheckOut, newRoomType, specialRequests });
        }

        const result = await modifyReservation({
          confirmationNumber,
          newCheckIn,
          newCheckOut,
          newRoomType,
          specialRequests,
          confirm: !!confirmationToken,
        });

        if ("requiresConfirmation" in result) {
          const token = createConfirmationToken("modify_reservation", {
            confirmationNumber,
            newCheckIn,
            newCheckOut,
            newRoomType,
            specialRequests,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    confirmationToken: token,
                    preview: result.preview,
                    note: "Call modify_reservation with the confirmationToken above to apply changes. IMPORTANT: Only do this after explicit user confirmation. Token expires in 5 minutes.",
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
        const { confirmationNumber, confirmationToken } = CancelReservationSchema.parse(args);

        if (confirmationToken) {
          validateConfirmationToken(confirmationToken, "cancel_reservation", { confirmationNumber });
        }

        const result = await cancelReservation({
          confirmationNumber,
          confirm: !!confirmationToken,
        });

        if ("requiresConfirmation" in result) {
          const token = createConfirmationToken("cancel_reservation", {
            confirmationNumber,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    requiresConfirmation: result.requiresConfirmation,
                    confirmationToken: token,
                    preview: result.preview,
                    note: "Call cancel_reservation with the confirmationToken above to cancel. IMPORTANT: Only do this after explicit user confirmation. This cannot be undone. Token expires in 5 minutes.",
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
        const { confirmationNumber, estimatedArrivalTime, roomPreferences } =
          CheckInSchema.parse(args);

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
        const result = await redeemPoints(RedeemPointsSchema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.success };
      }

      case "get_stay_history": {
        const { limit } = StayHistorySchema.parse(args || {});
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
    const errorMessage = sanitizeError(error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
              code: error instanceof MarriottPageError ? error.code : undefined,
              suggestion:
                errorMessage.toLowerCase().includes("login") ||
                errorMessage.toLowerCase().includes("auth") ||
                errorMessage.toLowerCase().includes("signin")
                  ? "Use the login tool to authenticate, or set MARRIOTT_EMAIL and MARRIOTT_PASSWORD environment variables."
                  : errorMessage.toLowerCase().includes("invalid input")
                  ? "Check the input parameters and try again."
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
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
