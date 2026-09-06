# @striderlabs/mcp-marriott

MCP server for Marriott Hotels — let AI agents search hotels, manage reservations, check in, and interact with the Marriott Bonvoy loyalty program via browser automation.

Built by [Strider Labs](https://striderlabs.ai).

## Overview

This MCP server enables AI agents (Claude, etc.) to:

- Search Marriott properties worldwide
- Browse room types and rates
- Complete hotel bookings
- Manage existing reservations (view, modify, cancel)
- Mobile check-in
- Track Marriott Bonvoy points and tier status
- Redeem Bonvoy points for award stays
- View past stay history

## Tools

| Tool | Description |
|------|-------------|
| `status` | Check login status and Bonvoy session info |
| `login` | Log in to Marriott Bonvoy (auto or manual) |
| `logout` | Clear saved session and cookies |
| `search_hotels` | Search hotels by destination, dates, guests |
| `get_hotel_details` | Get amenities, policies, check-in times |
| `get_room_options` | View available room types and rates |
| `select_room` | Choose a room before checkout |
| `add_extras` | Add parking, breakfast, late checkout, etc. |
| `checkout` | Complete booking (requires explicit confirmation) |
| `get_reservation` | Retrieve existing reservations |
| `modify_reservation` | Change dates or room type |
| `cancel_reservation` | Cancel a booking |
| `check_in` | Mobile check-in with room preferences |
| `get_bonvoy_status` | Points balance, tier, nights to upgrade |
| `redeem_points` | Book award stays with Bonvoy points |
| `get_stay_history` | View past stays and points earned |

## Setup

### 1. Install

```bash
npm install -g @striderlabs/mcp-marriott
```

Or run directly with npx:

```bash
npx @striderlabs/mcp-marriott
```

### 2. Install Playwright browsers

```bash
npx playwright install chromium
```

### 3. Login

This server uses secure, encrypted storage for your session. To log in, use the `login` tool provided by the server. It will provide a secure login URL where you can enter your credentials manually in your browser.

### 4. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "marriott": {
      "command": "npx",
      "args": ["@striderlabs/mcp-marriott"]
    }
  }
}
```

### 5. Configure Cursor / other MCP clients

```json
{
  "mcp": {
    "servers": {
      "marriott": {
        "command": "npx",
        "args": ["@striderlabs/mcp-marriott"]
      }
    }
  }
}
```

## Usage Examples

### Search hotels

```
Search for Marriott hotels in Tokyo from July 10-15 for 2 adults
```

### Book a room

```
Find me a room at the W Hotel Times Square for next weekend, then book the cheapest option
```

### Check Bonvoy status

```
How many Bonvoy points do I have and what's my current tier?
```

### Redeem points

```
Use my Bonvoy points to book a standard room at the Marriott Marquis in NYC for March 20-22
```

### Manage a reservation

```
Show me my upcoming reservations and cancel the one in Chicago
```

## Session Management

Cookies are saved to `~/.striderlabs/marriott/` so sessions persist between runs. To log out:

```
Use the logout tool
```

Or delete the directory:

```bash
rm -rf ~/.striderlabs/marriott/
```

## Safety & Confirmations

**Destructive actions require explicit confirmation:**

- `checkout` — requires `confirm: true`
- `modify_reservation` — requires `confirm: true`
- `cancel_reservation` — requires `confirm: true`
- `redeem_points` — requires `confirm: true`

Without `confirm: true`, these tools return a **preview** of what would happen, giving users a chance to review before committing.

## Development

```bash
git clone https://github.com/markswendsen-code/mcp-marriott
cd mcp-marriott
npm install
npm run build
node dist/index.js
```



## Legal Disclaimer

> **⚠️ IMPORTANT:** This software automates interactions with Marriott.com. It is not affiliated with, endorsed by, or sponsored by Marriott International, Inc.
> Using this tool to automate bookings or scrape data may violate Marriott's Terms of Service. This software is provided for educational purposes only. Use at your own risk. The authors are not responsible for any account bans, cancellations, or financial losses incurred through the use of this tool.

## License

MIT — [Strider Labs](https://striderlabs.ai)
