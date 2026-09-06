/**
 * Strider Labs - Confirmation Tokens
 *
 * Cryptographic token-based confirmation for destructive actions.
 * Replaces the simple `confirm: boolean` pattern with single-use,
 * time-limited tokens that must be generated from a preview step.
 */

import * as crypto from "crypto";

interface PendingConfirmation {
  token: string;
  action: string;
  data: Record<string, unknown>;
  expires: number;
}

/** In-memory store of pending confirmations */
const pending = new Map<string, PendingConfirmation>();

/** Token validity period: 5 minutes */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Create a single-use confirmation token for a destructive action.
 * Returns the token string to include in the preview response.
 *
 * @param action - The action type (e.g., "checkout", "cancel_reservation")
 * @param data - The action parameters to lock in (prevents modification between preview and confirm)
 */
export function createConfirmationToken(
  action: string,
  data: Record<string, unknown>
): string {
  // Clean up expired tokens
  pruneExpired();

  const token = crypto.randomBytes(16).toString("hex");
  pending.set(token, {
    token,
    action,
    data,
    expires: Date.now() + TOKEN_TTL_MS,
  });

  return token;
}

/**
 * Validate and consume a confirmation token.
 * Tokens are single-use — once validated, they are deleted.
 *
 * @param token - The token string from the preview response
 * @param expectedAction - The action type this token should authorize
 * @returns The locked-in action data
 * @throws Error if token is invalid, expired, or for the wrong action
 */
export function validateConfirmationToken(
  token: string,
  expectedAction: string
): Record<string, unknown> {
  pruneExpired();

  const entry = pending.get(token);

  if (!entry) {
    throw new Error(
      "Invalid or expired confirmation token. Please start the action again to get a new preview."
    );
  }

  if (Date.now() > entry.expires) {
    pending.delete(token);
    throw new Error(
      "Confirmation token has expired (5-minute limit). Please start the action again."
    );
  }

  if (entry.action !== expectedAction) {
    throw new Error(
      `Confirmation token is for "${entry.action}", not "${expectedAction}".`
    );
  }

  // Single-use: delete after successful validation
  pending.delete(token);

  return entry.data;
}

/**
 * Remove all expired tokens from the store
 */
function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now > entry.expires) {
      pending.delete(key);
    }
  }
}

/**
 * Clear all pending confirmations (e.g., on logout)
 */
export function clearPendingConfirmations(): void {
  pending.clear();
}
