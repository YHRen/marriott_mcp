# marriott_mcp

An unofficial Model Context Protocol server for searching Marriott properties, comparing configured special-rate categories, and reviewing cancellation and eligibility terms through a user-controlled Chrome session.

Repository: [YHRen/marriott_mcp](https://github.com/YHRen/marriott_mcp)

## Current capabilities

- Attach to a dedicated, locally running Chrome profile without exporting its cookies.
- Search regular, AAA/CAA, senior, government/military, and corporate/promo categories independently.
- Restrict government results to explicitly identified federal offers.
- Expand Marriott's current room-rate page and parse each room/rate combination separately.
- Read tax-inclusive stay totals, cancellation wording, eligibility, room-pool codes, and rate-program codes.
- Require confirmation tokens and revalidation before supported booking mutations.

This project does not promise to bypass Marriott's bot protection. Challenges, access denials, unrecognized pages, and incomplete terms are reported explicitly. It is not affiliated with or endorsed by Marriott International.

## Run from GitHub with npx

The recommended deployment keeps two responsibilities separate:

1. The user starts a dedicated Chrome profile with local debugging enabled and signs in to Marriott.
2. The MCP client starts this server through `npx` and attaches to that profile.

`npx` starts the MCP server; it does **not** start the dedicated Chrome process. Chrome must be running before the first Marriott tool call (starting it before the MCP client is simplest). On macOS:

```bash
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/Library/Application Support/Marriott-MCP-Chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  "https://www.marriott.com/"
```

Use that window to choose cookie preferences, sign in, and complete MFA. The dedicated profile retains its own cookies between launches. Do not use an everyday browsing profile, and do not expose or forward port `9222`.

Configure the MCP client to install and run the tagged GitHub source:

```json
{
  "mcpServers": {
    "marriott": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=github:YHRen/marriott_mcp#v0.1.0",
        "--",
        "mcp-marriott"
      ],
      "env": {
        "MARRIOTT_CDP_URL": "http://127.0.0.1:9222",
        "MARRIOTT_SPECIAL_RATES": "government",
        "MARRIOTT_GOVERNMENT_SCOPE": "federal"
      }
    }
  }
}
```

The repository currently is private, so the account running `npx` must have authenticated Git access to `YHRen/marriott_mcp`. A public repository would allow anonymous installation. The first launch can take longer because npm clones the Git repository, installs dependencies, and runs its `prepare` build; subsequent launches use npm's cache. The version tag is pinned so a later change to `main` cannot silently alter the installed server.

This GitHub package-spec workflow is supported by npm. It requires Node.js/npm and Git on the MCP host.

## Clone and run for development

```bash
git clone git@github.com:YHRen/marriott_mcp.git
cd marriott_mcp
npm ci
npx playwright install chromium
npm run build
node dist/index.js
```

The browser is visible by default so you can sign in and complete website verification in the same session. To use an installed Google Chrome instead of downloading Chromium:

```bash
MARRIOTT_BROWSER_CHANNEL=chrome node dist/index.js
```

For a development checkout, an MCP client can run the built local file directly:

```json
{
  "mcpServers": {
    "marriott": {
      "command": "node",
      "args": ["/absolute/path/to/marriott_mcp/dist/index.js"],
      "env": { "MARRIOTT_BROWSER_CHANNEL": "chrome" }
    }
  }
}
```

Optional environment settings:

| Setting | Purpose |
| --- | --- |
| `MARRIOTT_BROWSER_CHANNEL=chrome` | Use installed Chrome with a separate automation session. |
| `MARRIOTT_CDP_URL=http://127.0.0.1:9222` | Attach to a user-launched, dedicated Chrome profile instead of launching a browser. |
| `MARRIOTT_HEADLESS=true` | Hide the browser. Manual login/recovery then requires restarting in headed mode. |
| `MARRIOTT_CONFIG_DIR=/absolute/path` | Override the encrypted storage directory. |
| `MARRIOTT_NO_SANDBOX=true` | Explicitly disable Chromium's sandbox for environments that require it. |
| `MARRIOTT_SPECIAL_RATES=regular,government` | Comma-separated search categories; defaults to regular plus government. Use `government` for government-only searches. |
| `MARRIOTT_GOVERNMENT_SCOPE=federal` | Default government filter: `federal` (default) or `all`. Federal-only excludes state-only, military-only and ambiguous eligibility. |
| `MARRIOTT_CORPORATE_CODE=ABC` | Corporate/promo code; required only when `corporate_promo` is selected. |

The optional legacy `MARRIOTT_EMAIL`/`MARRIOTT_PASSWORD` environment variables enable automatic login. Manual login avoids storing an account password in client configuration.

## Attach to a dedicated Chrome profile

If a normally launched dedicated profile works, you can test attaching the MCP to it. Fully quit only that dedicated Chrome instance, then restart the same profile with a local debugging endpoint (macOS example):

```bash
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/Library/Application Support/Marriott-MCP-Chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  "https://www.marriott.com/"
```

Check that Marriott still works before connecting. Cookie consent is yours to choose; additional marketing cookies are not requested by the MCP. A restart may require signing in or completing MFA again.

```bash
MARRIOTT_CDP_URL=http://127.0.0.1:9222 node dist/index.js
```

For an MCP client, set that environment variable in its server configuration. Only numeric loopback HTTP endpoints with an explicit port are accepted. Debugging grants control of that dedicated browser to local processes; use it only while needed and never expose or forward the port. Do not use your everyday browsing profile. [Chrome's debugging/profile guidance](https://developer.chrome.com/blog/remote-debugging-port)

Attached mode creates its own tab in the existing context. It does not override the profile's cookies, consent, locale, viewport, headers, or request routing, and does not export its cookies or session metadata to the MCP storage directory. Chrome manages the profile's persistence. Booking-attempt records still use the MCP journal. Disconnecting closes the tool tab but preserves Chrome and its other tabs. `logout` disconnects and clears MCP authentication files; it does not sign the attached profile out of Marriott. Sign out on the website when desired, and restart Chrome without debugging to remove debugging access.

Live read-only validation succeeded with an attached dedicated Chrome profile, but attachment is not a guaranteed bot-detection bypass and site behavior can change.

## Login and browser verification

Call `login`, complete sign-in in the browser opened by this server, then call `status` to verify and save cookies. Signing in in another browser does not authenticate this session.

The server uses the browser's native user agent and browser properties. There is no guaranteed bot-detection bypass. When Marriott challenges or blocks a request, the tool reports `BOT_CHALLENGE`, `ACCESS_DENIED`, or `RATE_LIMITED`; it does not report zero availability. Call `recover_session` to bring the existing browser forward, complete verification there, and retry the search. A rate-limited session should wait before retrying.

Unrecognized results pages report `PAGE_CHANGED`. Login redirects report `AUTH_REQUIRED`. These states must not be interpreted as sold out.

## Configure special rates

Use [mcp-config.example.json](mcp-config.example.json) for a dedicated Chrome session with **federal-government-only** defaults. Replace its executable path with your checkout. This example is not automatically installed into your MCP client.

The menu categories map to these configuration/tool values:

| Marriott menu | `specialRates` value | Search code |
| --- | --- | --- |
| Lowest Regular Rate | `regular` | `none` |
| AAA/CAA | `aaa_caa` | `aaa` |
| Senior Discount | `senior` | `S9R` |
| Government & Military | `government` | `gov` |
| Corp/Promo Code | `corporate_promo` | `corp` plus your code |

For example, set this `env` object in the MCP client's server configuration to inspect several categories:

```json
{
  "MARRIOTT_CDP_URL": "http://127.0.0.1:9222",
  "MARRIOTT_SPECIAL_RATES": "regular,aaa_caa,senior,government,corporate_promo",
  "MARRIOTT_GOVERNMENT_SCOPE": "federal",
  "MARRIOTT_CORPORATE_CODE": "YOURCODE"
}
```

Replace `YOURCODE` with an authorized code, or omit `corporate_promo` and its code setting. Selecting a discount does **not** assert that the traveler qualifies. Restart the MCP server after editing its environment.

Each tool call can replace the category defaults, for example:

```json
{
  "destination": "Argonne National Laboratory, Lemont, Illinois",
  "checkIn": "2026-10-14",
  "checkOut": "2026-10-16",
  "adults": 1,
  "rooms": 1,
  "specialRates": ["regular", "government"],
  "governmentScope": "federal"
}
```

Explicit tool settings take precedence over the corresponding environment defaults. Empty lists, duplicates, unknown categories, invalid scope, and missing/invalid corporate codes fail before browser work. An explicit `specialRates` list cannot be combined with the deprecated `rateType` alias (`regular`, `government`, `both`).

## Review all selected rates

`search_hotels` accepts destination, ISO dates, adults/children **per room**, rooms, and:

- `specialRates`: one or more categories above; omitted values use MCP configuration.
- `governmentScope`: `federal` or `all`; default `federal` unless configured otherwise.
- `corporateCode`: overrides the configured corporate/promo code.
- `maxResults`: maximum properties inspected, default 10, maximum 50.
- `maxPages`: maximum hotel result pages per rate category, default 5, maximum 10.

Each selected category is searched separately with identical dates and occupancy. Government searches now use Marriott's **Government & Military** menu category (`gov`), not the separate corporate-code search with `GOV`. Federal-only filtering additionally requires explicit federal eligibility evidence in each returned rate. State-only, military-only or unspecified government rates do not establish federal availability. `governmentScope: "all"` retains all verified government subcategories for other users.

On Marriott's current `rateListMenu.mi` layout, the adapter expands every visible room, switches the page to **Show with taxes and fees**, and parses each member/non-member rate separately. It accepts room and rate identifiers only when the room-detail URL and decoded product identifier agree on property, room pool, and rate program. This prevents a price or cancellation policy from one rate being attached to another.

`get_room_options` accepts a hotelId and the same stay and special-rate options, plus `usePoints`. Award searches use regular award inventory instead of cash-rate configuration defaults; explicitly mixing special cash rates with points is rejected. Rate pagination/load-more controls are followed for up to five pages per category; recognized Rate Details controls are expanded.

Responses include:

- `offers`: **all matching inspected offers**, not only the cheapest or refundable ones. Each includes `offerId`, room/rate codes, requested selection, government subcategory, dates, occupancy, money, cancellation/deposit terms, eligibility, and observation time.
- `rateResults`: one entry per selected category, containing its `selection`, `offers`, `availability`, `unmatchedRateCount`, and coverage/error information. Unmatched or unclassifiable fallback rates are counted, not relabeled as the requested discount.
- `searches` and `selectedRates` on hotel searches: category discovery coverage, failures and resolved configuration, even when no hotel could be verified.
- `governmentAvailability`: `available`, `unavailable`, `unknown`, or `not_requested`.
- `coverage.complete` and a note explaining incomplete coverage.

The tool no longer returns automatic `comparisons`/lowest-rate winners. The agent should present the category, full-stay total, cancellation policy/deadline, deposit and eligibility terms to the user, then let the user decide. Search does not select a room, confirm eligibility or book anything. Full-stay totals are read from the website; nightly prices are not multiplied to invent a stay total. Money contains currency, integer minor units, and fraction digits. A bare dollar symbol does not establish USD.

Refundability belongs to the individual rate. The adapter requires affirmative cancellation terms, deposit terms, and an unexpired deadline with an explicit UTC offset before classifying a rate as refundable. Missing or ambiguous terms remain `unknown`; nonrefundable deposits override positive cancellation wording. Raw deadline text is retained for review.

The current page often displays a cancellation date but omits the cutoff time, UTC offset, and deposit/guarantee terms. Such offers retain the website's exact cancellation wording but remain `refundability: "unknown"`; agents should show that wording to the user instead of upgrading it to a verified refundable classification. The parser does not click the current Rate Details information icon because live inspection showed that its SPA handler can open a room-selected flyout.

Missing identifiers, unexpanded rates, page limits, incomplete terms, or uncertain pagination are disclosed. A category whose page cannot be parsed remains `unknown`, while other selected categories can still be reported. Site blocks, login challenges and rate limits stop the operation rather than continuing to make category requests. No currency conversion or automatic ranking is performed.

Corporate offers require both an observed matching corporate-code filter and corporate/negotiated/promo evidence in the rate's name or eligibility. An unrecognized branded corporate offer stays unverified; the requested code alone is not proof. AAA/CAA and senior offers likewise require affirmative rate-name/eligibility evidence.

Government availability does not establish eligibility. Read each offer's terms, including any official-travel and identification requirements. Marriott documents this in its [government-rate eligibility guidance](https://help.marriott.com/s/article/marriott-government-rates-eligibility) and [government/military discount guidance](https://help.marriott.com/s/article/military-discounts). Cancellation deadlines use the hotel's local time; see [Marriott cancellation guidance](https://help.marriott.com/s/article/find-marriott-cancellation-policy).

## Booking

1. Search for offers, then call `select_room` with the exact `offerId` (or pass `offerId` directly to checkout).
2. Call `checkout` with guest details to obtain a preview. Government offers require `governmentEligibilityConfirmed: true`; other special rates require `specialRateEligibilityConfirmed: true`, after reviewing the traveler's eligibility. Merely configuring categories does not supply that approval.
3. Review the exact hotel, room, rate, occupancy, stay total, deposit, and cancellation terms with the user.
4. Only after explicit approval call `checkout` with the returned `confirmationToken`. A token-only call uses the saved parameters.

Tokens are single-use, expire after five minutes, and are bound to the saved request and offer. Changed parameters are rejected. Changed prices or terms generate a new preview or stop checkout; they are never submitted under the old approval. Offers expire after fifteen minutes.

The checkout page must expose an identifiable booking summary and matching stay, room and rate. Missing evidence stops checkout before submission. Only an explicit Complete Booking control is used.

A successful response requires a confirmation number and matching stay/room/rate evidence after submission. An ambiguous outcome is `unknown`, never success or an instruction to resubmit. A persistent booking-attempt journal prevents the same stay from being automatically submitted again across server restarts. Check `get_reservation`, Marriott, or your confirmation email to reconcile it. The journal intentionally also blocks another identical stay after a confirmed booking; do not delete it merely to retry an uncertain submission. Run one server process per storage directory.

For points bookings, search with `usePoints: true`, select an award offer, and use `redeem_points` for preview and token confirmation. Exact points and any cash component must be verified.

`modify_reservation` and `cancel_reservation` use previews and confirmation tokens too; repeat their original parameters with the token. Legacy `confirm: true` is rejected. Tokens enforce a preview and parameter binding; the MCP client remains responsible for obtaining explicit human approval.

`add_extras` reports unsupported instead of claiming services were added. Choose a rate with the desired inclusions or arrange extras with the hotel.

## Storage

Cookies and session metadata are encrypted under `~/.striderlabs/marriott/` by default, with owner-only file/directory permissions. Valid session cookies (expiry `-1`) are retained.

Encryption is not an OS keychain: the stored salt plus the originating hostname/username can derive the key. Protect full directory backups accordingly.

`logout` clears authentication, pending confirmations, and selected offers. It retains the booking-attempt journal to prevent accidental duplicate reservations.

## Verification and limitations

```bash
npm test
npm run build
# Use installed Chrome for local browser fixtures:
MARRIOTT_BROWSER_CHANNEL=chrome npm test
```

Storage tests create and remove their own temporary directories. Browser tests fulfill all page requests with local HTML fixtures and mock the booking journal; they never contact Marriott or submit real bookings.

The browser adapter is deliberately conservative about unrecognized markup. Fixture tests verify behavior, not Marriott's current production selectors or bot-protection acceptance. A live read-only search and manual review of checkout are still required before relying on this adapter for a particular Marriott page variant. This project is not affiliated with Marriott.

The current `rateListMenu.mi` room/rate layout has been validated live for regular and federal-government searches, including multi-room-card expansion, tax-inclusive totals, rate-program codes, room-pool codes, eligibility, and visible cancellation wording. Full checkout parsing and automatic selection on this layout remain separate work; offers missing guarantee/deposit evidence are intentionally not bookable. The five category codes above were inspected from the live menu.

`SECURITY_REVIEW.md` is the historical review of the original implementation, not a current audit of these changes.
