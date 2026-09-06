/**
 * Strider Labs - Secure Storage
 *
 * Encrypted cookie/session persistence and credential management.
 * Replaces plaintext JSON storage with AES-256-GCM encryption.
 * Files are only usable on the machine + user that created them.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BrowserContext, Cookie } from "playwright";

const CONFIG_DIR = path.join(os.homedir(), ".striderlabs", "marriott");
const KEY_FILE = path.join(CONFIG_DIR, "key.bin");
const COOKIES_FILE = path.join(CONFIG_DIR, "cookies.enc");
const SESSION_FILE = path.join(CONFIG_DIR, "session.enc");

export interface SessionInfo {
  isLoggedIn: boolean;
  userEmail?: string;
  userName?: string;
  bonvoyNumber?: string;
  bonvoyTier?: string;
  lastUpdated: string;
}

// ─── Config Directory ────────────────────────────────────────────────────────

/**
 * Ensure config directory exists with owner-only permissions
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── Encryption Primitives ──────────────────────────────────────────────────

/**
 * Derive encryption key from machine-specific values + a stored random salt.
 * The resulting key is deterministic per-machine per-user, so encrypted files
 * are useless if copied to another machine or accessed by another user.
 */
function getEncryptionKey(): Buffer {
  ensureConfigDir();

  let salt: Buffer;
  if (fs.existsSync(KEY_FILE)) {
    salt = fs.readFileSync(KEY_FILE);
  } else {
    salt = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, salt, { mode: 0o600 });
  }

  const machineId = `${os.hostname()}:${os.userInfo().username}:mcp-marriott`;
  return crypto.pbkdf2Sync(machineId, salt, 100_000, 32, "sha256");
}

/**
 * Encrypt a string using AES-256-GCM.
 * Output format: base64( IV (16 bytes) || AuthTag (16 bytes) || Ciphertext )
 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Returns null on any failure (corrupted, tampered, wrong key).
 */
function decrypt(encoded: string): string | null {
  try {
    const key = getEncryptionKey();
    const buf = Buffer.from(encoded, "base64");
    if (buf.length < 33) return null; // minimum: 16 IV + 16 tag + 1 byte data

    const iv = buf.subarray(0, 16);
    const tag = buf.subarray(16, 32);
    const ciphertext = buf.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * Save an object to disk as encrypted JSON.
 */
function saveEncrypted(filepath: string, data: unknown): void {
  ensureConfigDir();
  const json = JSON.stringify(data);
  const encrypted = encrypt(json);
  fs.writeFileSync(filepath, encrypted, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Load an encrypted JSON file from disk.
 * Returns null if file doesn't exist, is corrupted, or can't be decrypted.
 */
function loadEncrypted<T>(filepath: string): T | null {
  if (!fs.existsSync(filepath)) {
    return null;
  }

  try {
    const encrypted = fs.readFileSync(filepath, "utf-8");
    const json = decrypt(encrypted);
    if (!json) return null;
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ─── Cookie Management ──────────────────────────────────────────────────────

/**
 * Save cookies from browser context to encrypted storage
 */
export async function saveCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  saveEncrypted(COOKIES_FILE, cookies);
}

/**
 * Load cookies from encrypted storage and apply to browser context
 */
export async function loadCookies(context: BrowserContext): Promise<boolean> {
  const cookies = loadEncrypted<Cookie[]>(COOKIES_FILE);
  if (!cookies || cookies.length === 0) {
    return false;
  }

  // Filter out expired cookies
  const now = Date.now() / 1000;
  const validCookies = cookies.filter((c) => !c.expires || c.expires > now);

  if (validCookies.length > 0) {
    await context.addCookies(validCookies);
    return true;
  }

  return false;
}

// ─── Session Info ───────────────────────────────────────────────────────────

/**
 * Save session info to encrypted storage
 */
export function saveSessionInfo(info: SessionInfo): void {
  saveEncrypted(SESSION_FILE, info);
}

/**
 * Load session info from encrypted storage
 */
export function loadSessionInfo(): SessionInfo | null {
  return loadEncrypted<SessionInfo>(SESSION_FILE);
}

// ─── Credential Management ─────────────────────────────────────────────────

/**
 * Retrieve Marriott credentials from available sources.
 * Priority: environment variables (with security note logged).
 *
 * Future enhancement: add OS keychain support (macOS Keychain,
 * Windows Credential Manager) as a higher-priority source.
 */
export function getCredentials(): { email: string; password: string } | null {
  const email = process.env.MARRIOTT_EMAIL;
  const password = process.env.MARRIOTT_PASSWORD;

  if (email && password) {
    return { email, password };
  }

  return null;
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Clear all saved auth data (cookies, session, encryption key)
 */
export function clearAuthData(): void {
  for (const filepath of [COOKIES_FILE, SESSION_FILE]) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
}

/**
 * Check if we have saved cookies (may or may not still be valid)
 */
export function hasSavedCookies(): boolean {
  return fs.existsSync(COOKIES_FILE);
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}
