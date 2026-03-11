/**
 * Strider Labs - Marriott Auth/Session Management
 *
 * Handles cookie persistence and session management for Marriott.com.
 */
import type { BrowserContext } from "playwright";
export interface SessionInfo {
    isLoggedIn: boolean;
    userEmail?: string;
    userName?: string;
    bonvoyNumber?: string;
    bonvoyTier?: string;
    lastUpdated: string;
}
/**
 * Save cookies from browser context to disk
 */
export declare function saveCookies(context: BrowserContext): Promise<void>;
/**
 * Load cookies from disk and apply to browser context
 */
export declare function loadCookies(context: BrowserContext): Promise<boolean>;
/**
 * Save session info to disk
 */
export declare function saveSessionInfo(info: SessionInfo): void;
/**
 * Load session info from disk
 */
export declare function loadSessionInfo(): SessionInfo | null;
/**
 * Clear all saved auth data
 */
export declare function clearAuthData(): void;
/**
 * Check if we have saved cookies (may or may not still be valid)
 */
export declare function hasSavedCookies(): boolean;
/**
 * Get the config directory path (useful for debugging)
 */
export declare function getConfigDir(): string;
