import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const signOutCount = vi.fn().mockResolvedValue(0);
  const page = { setDefaultTimeout: vi.fn(), bringToFront: vi.fn(), isClosed: () => false, close: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn(), url: vi.fn().mockReturnValue("https://www.marriott.com/loyalty/myAccount/default.mi"),
    title: vi.fn().mockResolvedValue("My Account"),
    $eval: vi.fn().mockResolvedValue("Fixture member"),
    locator: vi.fn().mockReturnValue({ innerText: async () => "Account", count: async () => 0,
      filter: () => ({ count: signOutCount }) }) };
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined), route: vi.fn() };
  const browser = { contexts: () => [context], close: vi.fn().mockResolvedValue(undefined), isConnected: () => true };
  return { page, context, browser, signOutCount, connect: vi.fn().mockResolvedValue(browser), launch: vi.fn(),
    saveCookies: vi.fn(), loadCookies: vi.fn(), saveSessionInfo: vi.fn(), clearAuthData: vi.fn() };
});
vi.mock("playwright", () => ({ chromium: { connectOverCDP: mock.connect, launch: mock.launch } }));
vi.mock("../src/secure-store.js", () => ({
  saveCookies: mock.saveCookies, loadCookies: mock.loadCookies, saveSessionInfo: mock.saveSessionInfo,
  clearAuthData: mock.clearAuthData, getCredentials: vi.fn(), loadBookingAttempts: () => ({}), saveBookingAttempt: vi.fn(),
}));

import { validateCdpUrl } from "../src/cdp.js";
import { checkLoginStatus, closeBrowser, logoutBrowser, recoverSession } from "../src/browser.js";

beforeEach(() => {
  vi.clearAllMocks();
  mock.page.url.mockReturnValue("https://www.marriott.com/loyalty/myAccount/default.mi");
  mock.page.title.mockResolvedValue("My Account");
  mock.page.$eval.mockResolvedValue("Fixture member");
  mock.signOutCount.mockResolvedValue(0);
  vi.stubEnv("MARRIOTT_CDP_URL", "http://127.0.0.1:9222");
});
afterEach(async () => { await closeBrowser(); vi.unstubAllEnvs(); });

it("accepts only explicit loopback endpoints", () => {
  expect(validateCdpUrl("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222/");
  expect(validateCdpUrl("http://[::1]:9222")).toBe("http://[::1]:9222/");
  for (const url of ["http://example.com:9222", "http://0.0.0.0:9222", "http://127.0.0.1", "http://user:password@127.0.0.1:9222", "http://127.0.0.1:9222/path", "http://127.0.0.1:9222/?token=secret"]) {
    expect(() => validateCdpUrl(url)).toThrow();
  }
});

it("uses the existing context without replacing cookies, settings or request routing", async () => {
  await recoverSession();
  expect(mock.connect).toHaveBeenCalledWith("http://127.0.0.1:9222/", { timeout: 10000 });
  expect(mock.context.newPage).toHaveBeenCalledTimes(1);
  expect(mock.launch).not.toHaveBeenCalled();
  expect(mock.loadCookies).not.toHaveBeenCalled();
  expect(mock.context.route).not.toHaveBeenCalled();
  const status = await checkLoginStatus();
  expect(status.isLoggedIn).toBe(true);
  expect(mock.saveCookies).not.toHaveBeenCalled();
  expect(mock.saveSessionInfo).not.toHaveBeenCalled();
});

it("disconnects and closes only the tool tab, preserving the user profile", async () => {
  await recoverSession();
  const result = await logoutBrowser();
  expect(result.message).toContain("Chrome remains signed in");
  expect(mock.page.close).toHaveBeenCalledTimes(1);
  expect(mock.context.close).not.toHaveBeenCalled();
  expect(mock.browser.close).toHaveBeenCalledTimes(1);
});

it("recognizes the current account page without extracting member identifiers", async () => {
  mock.page.$eval.mockResolvedValue(null);
  mock.signOutCount.mockResolvedValue(1);
  const status = await checkLoginStatus();
  expect(status.isLoggedIn).toBe(true);
  expect(status.bonvoyNumber).toBeUndefined();
  expect(mock.saveCookies).not.toHaveBeenCalled();
  expect(mock.saveSessionInfo).not.toHaveBeenCalled();
});

it("does not infer authentication from the account title alone", async () => {
  mock.page.$eval.mockResolvedValue(null);
  expect((await checkLoginStatus()).isLoggedIn).toBe(false);
});

it("requires the account route and title for the Sign Out fallback", async () => {
  mock.page.$eval.mockResolvedValue(null);
  mock.signOutCount.mockResolvedValue(1);
  mock.page.url.mockReturnValue("https://www.marriott.com/default.mi");
  expect((await checkLoginStatus()).isLoggedIn).toBe(false);
  mock.page.url.mockReturnValue("https://www.marriott.com/loyalty/myAccount/default.mi");
  mock.page.title.mockResolvedValue("Sign In");
  expect((await checkLoginStatus()).isLoggedIn).toBe(false);
});

it("recognizes Marriott's hyphenated sign-in redirect", async () => {
  mock.page.url.mockReturnValue("https://www.marriott.com/sign-in.mi");
  expect((await checkLoginStatus()).isLoggedIn).toBe(false);
  expect(mock.page.$eval).not.toHaveBeenCalled();
});
