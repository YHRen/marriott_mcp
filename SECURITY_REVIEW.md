# Comprehensive Security Review: `@striderlabs/mcp-marriott`

> Historical review of the original implementation. Some referenced files no longer exist and several findings have since been addressed. See README.md and the current tests for implemented behavior and remaining verification limits; this document is not a current security audit.

> **⚠️ CAUTION:** This codebase has **several critical and high-severity security issues** that should be addressed before any production use or public distribution. The most concerning involve credential handling, cookie storage, bot-detection evasion, input validation, and the overall trust model between the MCP client and this server.

---

## 1. Executive Summary

This is a Model Context Protocol (MCP) server that automates browser interactions with Marriott.com using Playwright. It allows AI agents to search hotels, manage reservations, check in, and interact with the Bonvoy loyalty program.

| Category | Rating | Details |
|---|---|---|
| **Credential Security** | 🔴 Critical | Plaintext env vars, no encryption at rest |
| **Session/Cookie Storage** | 🔴 Critical | Plaintext JSON on disk, world-readable |
| **Input Validation** | 🟠 High | No validation or sanitization anywhere |
| **Bot Detection Evasion** | 🟠 High | Active anti-detection measures raise ToS/legal concerns |
| **Error Handling** | 🟡 Medium | Potential info leakage in error messages |
| **Architecture** | 🟡 Medium | Singleton state, no concurrency safety |
| **Dependency Security** | 🟡 Medium | Minimal deps but loose version pinning |
| **Code Quality** | 🟢 Low risk | Clean TypeScript, good structure |

---

## 2. 🔴 Critical Security Issues

### 2.1 Plaintext Credential Storage & Handling

**Files:** `src/auth.ts`, `src/browser.ts` (lines 292-296)

The Marriott account password is read from an environment variable and used directly:

```typescript
// browser.ts:292-296
const email = process.env.MARRIOTT_EMAIL;
const password = process.env.MARRIOTT_PASSWORD;
```

**Problems:**
- **Environment variables are visible** in `/proc/<pid>/environ` on Linux, `ps eww` on macOS, and in process manager UIs. Any process on the system running as the same user can read them.
- The README instructs users to put credentials directly into Claude Desktop config JSON files, which are **plaintext files on disk**.
- No support for credential managers, keychains, or encrypted vaults.
- Password is passed directly to `performLogin()` and typed into a browser field — it could be captured in Playwright trace logs if tracing is ever enabled.

**Recommendation:**
- Support OS keychain integration (macOS Keychain, Windows Credential Manager).
- Support reading credentials from encrypted vaults or credential files with restricted permissions.
- Add a warning in the README about the risks of plaintext credential storage.
- Consider supporting OAuth/SSO flows that don't require password handling.

---

### 2.2 Plaintext Cookie & Session Storage

**File:** `src/auth.ts` (lines 12-14)

```typescript
const CONFIG_DIR = path.join(os.homedir(), ".striderlabs", "marriott");
const COOKIES_FILE = path.join(CONFIG_DIR, "cookies.json");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");
```

**Problems:**
- Cookies are stored as **plaintext JSON** at `~/.striderlabs/marriott/cookies.json`. These cookies represent an authenticated Marriott Bonvoy session — anyone who obtains them can **hijack the user's session** to:
  - View personal information (name, email, Bonvoy number)
  - Make hotel reservations charging the user's payment methods
  - Cancel existing reservations
  - Redeem loyalty points
- The directory is created with `fs.mkdirSync` using default permissions — on most systems this means `0o755`, **world-readable**.
- Session file at `session.json` contains PII (email, name, Bonvoy number, tier).
- No file permission restrictions are set on either file.

**Recommendation:**
- Set restrictive file permissions: `fs.writeFileSync(path, data, { mode: 0o600 })`.
- Set restrictive directory permissions: `fs.mkdirSync(path, { recursive: true, mode: 0o700 })`.
- Consider encrypting cookie data at rest using a key derived from a machine-specific secret.
- Add automatic session expiry — currently cookies are only filtered by their own `expires` field, but there's no server-side TTL.

---

### 2.3 Open Redirect / URL Injection in `getHotelDetails`

**File:** `src/browser.ts` (lines 507-517)

```typescript
export async function getHotelDetails(hotelIdOrUrl: string): Promise<HotelDetails> {
  let url: string;
  if (hotelIdOrUrl.startsWith("http")) {
    url = hotelIdOrUrl;  // ← Arbitrary URL navigation!
  } else {
    url = `${MARRIOTT_BASE_URL}/hotels/hotel-overview/${hotelIdOrUrl}.mi`;
  }
  await p.goto(url, ...);
```

**Problems:**
- An MCP client (or a prompt-injected AI) can pass **any arbitrary URL** as `hotelIdOrUrl`, and the browser will navigate to it.
- This enables:
  - **SSRF (Server-Side Request Forgery):** Navigate to internal network addresses (`http://169.254.169.254/...` for cloud metadata, `http://localhost:...`).
  - **Credential phishing:** Navigate to a look-alike login page that captures the cookies/session.
  - **Malware download:** Navigate to a page that triggers browser exploits.
- The same pattern appears implicitly anywhere `hotelId` values flow into URL construction without validation.

**Recommendation:**
- **Validate that all URLs are on `marriott.com`** before navigation:
  ```typescript
  function isMarriottUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith('.marriott.com');
    } catch { return false; }
  }
  ```
- **Sanitize `hotelId`** values to ensure they match expected patterns (e.g., `/^[A-Z0-9]{3,10}$/`).
- Apply URL validation to **all** `p.goto()` calls, not just `getHotelDetails`.

---

## 3. 🟠 High-Severity Issues

### 3.1 No Input Validation or Sanitization

**File:** `src/index.ts` (lines 442-1033)

The tool handler performs `args as { ... }` type assertions with **zero runtime validation**:

```typescript
// index.ts:517-533
const { destination, checkIn, checkOut, adults, children, rooms, maxResults = 10 } = 
  args as { destination: string; checkIn: string; ... };
```

**Problems:**
- **No date format validation:** `checkIn` and `checkOut` accept any string. Malformed dates could cause unexpected behavior or be injected into URL parameters.
- **No numeric range validation:** `adults`, `children`, `rooms` could be negative, zero, or extremely large numbers. `maxResults` is capped at 50 but not validated as positive.
- **No string length limits:** `destination`, `specialRequests`, `hotelId`, etc. have no length constraints. Very long strings could cause issues.
- **No confirmation number format validation:** `confirmationNumber` is used directly in URL construction (`browser.ts` lines 1060, 1135, 1189) — injecting path traversal or query parameters is possible:
  ```
  confirmationNumber = "ABC123&redirect=https://evil.com"
  ```
- **Email/phone not validated** in checkout — these are typed directly into the browser.

**Recommendation:**
- Add a validation layer (e.g., using Zod) for all tool inputs.
- Validate date formats with a regex like `/^\d{4}-\d{2}-\d{2}$/` and ensure logical ordering (checkIn < checkOut).
- Validate confirmation numbers against expected patterns.
- Use `encodeURIComponent` when embedding user input into URLs.
- Add string length limits to all text inputs.

---

### 3.2 Bot Detection Evasion — ToS & Legal Concerns

**File:** `src/browser.ts` (lines 161-191)

The code actively circumvents Marriott's bot detection:

```typescript
// Fake user agent
userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",

// Patch navigator to avoid bot detection
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
});

// Chrome launch args to disable automation signals
"--disable-blink-features=AutomationControlled",
```

**Problems:**
- This likely **violates Marriott's Terms of Service**, which typically prohibit automated access and scraping.
- Could violate the **Computer Fraud and Abuse Act (CFAA)** or similar laws in other jurisdictions.
- The `randomDelay()` function is specifically designed to evade rate limiting.
- Publishing this as an npm package could expose the authors and users to legal liability.
- Marriott could block or ban accounts that use this tool.

**Recommendation:**
- Add prominent legal disclaimers about ToS compliance.
- Investigate whether Marriott offers an official API or partner program.
- Consider adding a configuration option to disable anti-detection measures.
- Document the risks clearly in the README.

---

### 3.3 Confirmation Bypass is Weak

**Files:** `src/browser.ts` (line 839), `src/index.ts` (line 691)

The `confirm` parameter is the **only safeguard** preventing financial transactions:

```typescript
confirm = false  // default
...
if (!confirm) {
  return { requiresConfirmation: true, preview };
}
// Otherwise, proceed to charge money
```

**Problems:**
- The confirmation is a simple boolean parameter — there's no cryptographic token, nonce, or server-side state validation.
- A prompt-injected AI could easily set `confirm: true` in the tool call, bypassing the preview step entirely.
- There's no user-facing UI confirmation — the "confirmation" is purely in the tool schema description saying "NEVER set to true without explicit user confirmation," which is an instruction to the LLM, not an enforcement mechanism.
- The same `confirm: true` pattern is used for all destructive operations: checkout, modify, cancel, and redeem points.

**Recommendation:**
- Generate a time-limited confirmation token in the preview step that must be passed back to confirm.
- Log all confirmation actions with timestamps.
- Consider requiring a second factor or out-of-band confirmation for high-value operations.
- At minimum, add server-side state tracking to ensure a preview was actually generated before allowing confirmation.

---

## 4. 🟡 Medium-Severity Issues

### 4.1 Information Leakage in Error Messages

**File:** `src/index.ts` (lines 1003-1033)

```typescript
catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: errorMessage, ... }) }] };
}
```

- Raw error messages from Playwright and Marriott's website are exposed to the MCP client. These could contain:
  - Internal URLs or paths
  - Session tokens in redirected URLs
  - Stack traces with file paths
  - Marriott's internal error codes

**Recommendation:** Sanitize error messages before returning them. Map known errors to user-friendly messages and log raw errors internally.

---

### 4.2 Singleton Browser State — No Concurrency Safety

**File:** `src/browser.ts` (lines 19-26)

```typescript
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let selectedHotelId: string | null = null;
let selectedRoomCode: string | null = null;
let pendingExtras: string[] = [];
```

**Problems:**
- All state is in module-level mutable globals — if two tool calls execute concurrently (MCP allows this), they will interfere with each other.
- A `search_hotels` call could overwrite state while a `checkout` is in progress.
- `selectedHotelId`, `selectedRoomCode`, `pendingExtras` are shared across all operations — one user action could corrupt another's booking flow.
- No mutex, lock, or queue mechanism.

**Recommendation:**
- Add a request queue or mutex to serialize browser operations.
- Consider using a session/transaction ID to isolate booking flows.
- Or refactor to pass state explicitly rather than using globals.

---

### 4.3 No Sandbox Restriction on Chromium

**File:** `src/browser.ts` (lines 163-171)

```typescript
args: [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  ...
]
```

- `--no-sandbox` disables Chromium's security sandbox, meaning any browser exploit could escape to the host system.
- `--disable-setuid-sandbox` further weakens isolation.
- These flags are common in Docker containers but **dangerous on a user's workstation**.

**Recommendation:** Remove `--no-sandbox` flags. If needed, make them opt-in via an environment variable with a clear warning.

---

### 4.4 Config Directory Exposure

**File:** `src/index.ts` (line 460)

```typescript
configDir: getConfigDir(),  // Returns ~/.striderlabs/marriott/
```

The status tool returns the config directory path to the MCP client. This reveals the filesystem layout to the AI agent unnecessarily.

---

### 4.5 Stale User Agent

**File:** `src/browser.ts` (line 177)

```typescript
userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/120.0.0.0 ..."
```

- Chrome 120 is from December 2023 — a severely outdated version.
- This makes the browser fingerprint **more detectable** as automated, not less.
- The macOS version in the UA string may not match the actual host OS.

---

## 5. 🟢 Positive Security Aspects

- **Confirmation pattern for destructive actions:** While bypassable, the `confirm: true` pattern is a good UX safeguard.
- **Cookie expiry filtering:** `src/auth.ts` line 57 filters expired cookies.
- **`maxResults` capping:** `src/index.ts` line 542 caps at 50 to prevent resource abuse.
- **Strict TypeScript:** `tsconfig.json` has `strict: true`.
- **Minimal dependencies:** Only `playwright` and `@modelcontextprotocol/sdk` — small attack surface.
- **Clean error handling:** Errors are caught and returned as structured responses rather than crashing.
- **Browser cleanup on close:** `server.onclose` properly cleans up the browser.

---

## 6. Code Quality & Architecture Notes

### Good Practices
- Well-organized file structure (auth, browser, index separation)
- Comprehensive TypeScript interfaces for all data types
- Descriptive tool schemas with clear documentation
- Consistent async/await usage
- Reasonable default values

### Areas for Improvement
- **No tests** — no unit tests, integration tests, or test framework configured
- **No linting** — no ESLint, Prettier, or similar configured
- **No logging framework** — uses `console.error` directly
- **No retry logic** — browser operations will fail on transient network issues
- **Hardcoded selectors** — CSS selectors are hardcoded strings that will break when Marriott updates their website
- **`.gitignore` is too minimal** — missing coverage for `.env`, `*.log`, `.striderlabs/`, IDE configs

---

## 7. Priority Remediation Roadmap

| Priority | Issue | Effort |
|---|---|---|
| **P0** | Fix file permissions on cookie/session files (mode `0o600`) | ⏱ 30 min |
| **P0** | Add URL validation for all `p.goto()` calls | ⏱ 1 hour |
| **P0** | Add input validation (Zod) for all tool parameters | ⏱ 2-3 hours |
| **P0** | Add `.env` and `.striderlabs/` to `.gitignore` | ⏱ 5 min |
| **P1** | Remove `--no-sandbox` or make it opt-in | ⏱ 15 min |
| **P1** | Sanitize error messages before returning | ⏱ 1 hour |
| **P1** | Add confirmation tokens instead of boolean flags | ⏱ 2-3 hours |
| **P1** | Add concurrency protection (mutex/queue) | ⏱ 2 hours |
| **P2** | Support OS keychain for credentials | ⏱ 3-4 hours |
| **P2** | Add legal disclaimers and ToS warnings | ⏱ 30 min |
| **P2** | Encrypt cookies at rest | ⏱ 2-3 hours |
| **P2** | Add test framework and basic tests | ⏱ 4-6 hours |
| **P3** | Add logging framework | ⏱ 1-2 hours |
| **P3** | Update user agent string | ⏱ 15 min |
| **P3** | Remove `configDir` from status response | ⏱ 5 min |

---

## 8. Summary

This codebase is a well-structured MCP server with clean TypeScript code, but it has **significant security gaps** that are especially concerning given that it handles:

1. **Financial transactions** (hotel bookings that charge real money)
2. **Loyalty points** (Bonvoy points with real monetary value)
3. **Authentication credentials** (email/password for Marriott accounts)
4. **Personal information** (guest names, phone numbers, travel history)

The most urgent fixes are file permissions on credential storage, input validation, and URL sanitization. The confirmation mechanism should also be hardened before any real-world use.

---

*Review conducted on 2026-09-03.*
