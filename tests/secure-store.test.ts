/**
 * Tests for the secure storage module.
 *
 * Verifies that cookies and session data are encrypted at rest,
 * that file permissions are restrictive, and that tampered data
 * fails gracefully.
 */

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  saveSessionInfo,
  loadSessionInfo,
  clearAuthData,
  saveCookies,
  loadCookies,
  type SessionInfo,
} from "../src/secure-store.js";

const CONFIG_DIR = vi.hoisted(() => {
  // Hoisted before importing secure-store: never open real session files.
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marriott-storage-test-"));
  process.env.MARRIOTT_CONFIG_DIR = dir;
  return dir;
});
const SESSION_FILE = path.join(CONFIG_DIR, "session.enc");

afterAll(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  delete process.env.MARRIOTT_CONFIG_DIR;
});

afterEach(() => {
  clearAuthData();
});

describe("saveSessionInfo / loadSessionInfo", () => {
  it("roundtrips session data through encryption", () => {
    const session: SessionInfo = {
      isLoggedIn: true,
      userName: "Test User",
      bonvoyNumber: "123456789",
      bonvoyTier: "Gold",
      lastUpdated: new Date().toISOString(),
    };

    saveSessionInfo(session);
    const loaded = loadSessionInfo();

    expect(loaded).not.toBeNull();
    expect(loaded!.isLoggedIn).toBe(true);
    expect(loaded!.userName).toBe("Test User");
    expect(loaded!.bonvoyNumber).toBe("123456789");
    expect(loaded!.bonvoyTier).toBe("Gold");
  });

  it("stores data as encrypted (not readable JSON)", () => {
    saveSessionInfo({
      isLoggedIn: true,
      userName: "Secret User",
      lastUpdated: new Date().toISOString(),
    });

    const raw = fs.readFileSync(SESSION_FILE, "utf-8");

    // Should NOT contain plaintext user data
    expect(raw).not.toContain("Secret User");
    expect(raw).not.toContain("isLoggedIn");

    // Should look like base64 (encrypted content)
    expect(raw).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("creates files with restrictive permissions (0o600)", () => {
    saveSessionInfo({
      isLoggedIn: false,
      lastUpdated: new Date().toISOString(),
    });

    const stats = fs.statSync(SESSION_FILE);
    const mode = stats.mode & 0o777;

    // 0o600 = owner read/write only
    expect(mode).toBe(0o600);
  });

  it("creates config directory with restrictive permissions (0o700)", () => {
    saveSessionInfo({
      isLoggedIn: false,
      lastUpdated: new Date().toISOString(),
    });

    const stats = fs.statSync(CONFIG_DIR);
    const mode = stats.mode & 0o777;

    // 0o700 = owner only (may differ if dir existed before)
    // At minimum, should not be world-readable
    expect(mode & 0o077).toBe(0);
  });

  it("returns null for tampered data", () => {
    saveSessionInfo({
      isLoggedIn: true,
      userName: "Real User",
      lastUpdated: new Date().toISOString(),
    });

    // Tamper with the encrypted file
    fs.writeFileSync(SESSION_FILE, "this-is-definitely-not-valid-encrypted-data");

    const loaded = loadSessionInfo();
    expect(loaded).toBeNull();
  });

  it("returns null when no session exists", () => {
    clearAuthData();
    const loaded = loadSessionInfo();
    expect(loaded).toBeNull();
  });
});

describe("clearAuthData", () => {
  it("removes session file", () => {
    saveSessionInfo({
      isLoggedIn: true,
      lastUpdated: new Date().toISOString(),
    });

    expect(fs.existsSync(SESSION_FILE)).toBe(true);
    clearAuthData();
    expect(fs.existsSync(SESSION_FILE)).toBe(false);
  });
});

it("restores session cookies and excludes expired cookies", async () => {
  const base = { domain: ".marriott.com", path: "/", value: "test", httpOnly: true, secure: true, sameSite: "Lax" };
  await saveCookies({ cookies: async () => [
    { ...base, name: "session", expires: -1 },
    { ...base, name: "expired", expires: 1 },
    { ...base, name: "future", expires: Date.now() / 1000 + 3600 },
  ] } as any);
  const addCookies = vi.fn();
  expect(await loadCookies({ addCookies } as any)).toBe(true);
  expect(addCookies.mock.calls[0][0].map((c: any) => c.name)).toEqual(["session", "future"]);
});
