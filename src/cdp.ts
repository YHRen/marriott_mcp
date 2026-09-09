import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** A debugging endpoint grants browser control; never accept remote hosts here. */
export function validateCdpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MARRIOTT_CDP_URL must be a loopback HTTP endpoint with an explicit port, such as http://127.0.0.1:9222.");
  }
  return url.href;
}

export async function attachChrome(value: string): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.connectOverCDP(validateCdpUrl(value), { timeout: 10000 });
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw new Error("Expected one dedicated Chrome profile. Use a separate Marriott-only Chrome instance.");
    const context = contexts[0];
    // Own a new tab; do not navigate, close, or inspect the user's existing tabs.
    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    // For connectOverCDP, close disconnects the transport, not the user's Chrome.
    await browser.close().catch(() => {});
    throw error;
  }
}
