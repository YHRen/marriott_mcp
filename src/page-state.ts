import type { Page } from "playwright";

export class MarriottPageError extends Error {
  constructor(public code: "BOT_CHALLENGE" | "ACCESS_DENIED" | "RATE_LIMITED" | "PAGE_CHANGED" | "AUTH_REQUIRED" | "HTTP_ERROR", message: string) {
    super(message);
  }
}

export async function assertPageUsable(page: Page, status?: number): Promise<void> {
  if (status === 429) throw new MarriottPageError("RATE_LIMITED", "Marriott rate limited this session. Wait before retrying; no automatic retry was made.");
  if (status === 403) throw new MarriottPageError("ACCESS_DENIED", "Marriott denied this session. Use recover_session to open the same session for manual recovery.");
  if (status && status >= 400) throw new MarriottPageError("HTTP_ERROR", `Marriott returned HTTP ${status}.`);
  const body = (await page.locator("body").innerText()).slice(0, 15000);
  if (/access denied|you don't have permission to access/i.test(body)) {
    throw new MarriottPageError("ACCESS_DENIED", "Marriott denied this browser session. This is not a sign-in or availability result, and there may be no interactive challenge to complete.");
  }
  if (/verify (?:that )?you are (?:a )?human|unusual traffic|complete (?:the |this )?(?:security check|captcha)|press and hold|pardon our interruption/i.test(body) || await page.locator('iframe[src*="captcha"]:visible, [data-testid="captcha"]:visible').count()) {
    throw new MarriottPageError("BOT_CHALLENGE", "Marriott requires browser verification. Use recover_session, complete it in that browser, then retry the search.");
  }
  if (/\/(?:signin|login|loyalty\/loginPage)/i.test(new URL(page.url()).pathname)) {
    throw new MarriottPageError("AUTH_REQUIRED", "Sign in in the server's browser using login, then use status to verify.");
  }
}

export async function waitForResults(page: Page, cards: string, empty: string): Promise<"results" | "empty"> {
  await assertPageUsable(page);
  try {
    await page.locator(`${cards}, ${empty}`).first().waitFor({ state: "visible", timeout: 15000 });
  } catch {
    await assertPageUsable(page);
    throw new MarriottPageError("PAGE_CHANGED", "Expected results or an explicit no-availability message were not found. Availability is unknown.");
  }
  await assertPageUsable(page);
  if (await page.locator(cards).count()) return "results";
  return "empty";
}
