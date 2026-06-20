# gmap-place-saver

Resolve a place from a social or Google Maps URL (or free text), confirm **one**
candidate, and save it to the **correct regional** Google Maps saved list — with
optional source/recommendation notes. Ships as an **MCP server** (usable by any
MCP-capable agent) plus a CLI.

It automates the manual flow of "I saw a place on Instagram/Threads/Facebook →
which of my regional saved lists does it belong in → save it there → keep the
source link and why it was recommended."

## How it works

```
resolve_place(url|text)  ->  ONE candidate + a reusable savePayload   (no writes)
        |  (you/the agent confirm the candidate)
        v
save_place(savePayload)  ->  saves to the EXACT regional list
        |  (optional)
        v
attach_note(...)         ->  note on the exact place, else a local sidecar record
```

Resolution prefers a fast, cache-friendly path: high-confidence social posts
(place name + address + region) resolve from metadata in tens of milliseconds and
skip the browser. Weaker cases fall back to a Playwright lookup on Google Maps
using a persistent, logged-in browser profile.

## Requirements

- Node.js **>= 18** (uses the global `fetch`).
- A Google account and a persistent Chromium profile logged into it (see
  [One-time login](#one-time-login)).
- Playwright's Chromium: `npx playwright install chromium`.

## Install

```bash
git clone https://github.com/bolin8017/gmap-place-saver.git
cd gmap-place-saver
npm install
npx playwright install chromium
cp .env.example .env   # then edit GOOGLE_MAPS_PROFILE
```

## One-time login

Saving to *personal* lists requires a logged-in Google session. Create one once
into a persistent profile (needs a display — a desktop, or Xvfb/noVNC on a server):

```bash
GOOGLE_MAPS_PROFILE=/path/to/google-maps-profile npm run login
```

Sign in, open Google Maps, then press Enter. Every later run reuses that profile
headlessly. No Google credentials are ever passed to or stored by this tool.

## Configuration

All paths and tuning come from environment variables (see `.env.example`). Nothing
is hardcoded.

| Variable | Purpose | Default |
|---|---|---|
| `GOOGLE_MAPS_PROFILE` | Persistent Chromium profile (required for browser ops) | — |
| `GMAP_HOME` | Base dir for runtime data | the package dir |
| `GMAP_REGION_CONFIG` | Region → list mapping JSON | `$GMAP_HOME/config/region-lists.json` |
| `GMAP_CACHE` / `GMAP_SOCIAL_CACHE` | Candidate / social caches | under `$GMAP_HOME/cache` |
| `GMAP_BENCHMARK_LOG` | Benchmark JSONL | `$GMAP_HOME/logs/gmap-benchmark.jsonl` |
| `GMAP_FAILURE_DIR` | Failure artifacts (screenshots etc.) | `$GMAP_HOME/logs/failures` |
| `GMAP_SIDECAR_DIR` | Local note sidecar records | `$GMAP_HOME/data/sidecar-notes` |
| `GMAP_RETRIES` / `GMAP_RETRY_MIN_TIMEOUT_MS` | Navigation retry tuning | `2` / `750` |
| `YTDLP_COOKIES_FROM_BROWSER` | Let yt-dlp reuse browser cookies for captions | unset |

### Region config

Routing is driven by a JSON file whose **keys are your Google Maps saved-list
names** and whose **values are address substrings** that route an address to that
list. Ship your own (kept private — it is gitignored); see
`config/region-lists.example.json`:

```json
{
  "Taipei": ["台北市", "臺北市", "新北市"],
  "Kaohsiung": ["高雄市"],
  "Hong Kong": ["香港"]
}
```

If a place's region is ambiguous or its list is missing, the tool asks for
confirmation or fails clearly — it never silently saves to the wrong list.

## Use it from an AI agent (MCP)

The server is named `gmap` and speaks MCP over stdio. Point your agent at
`mcp/server.js` with the env it needs.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gmap": {
      "command": "node",
      "args": ["/absolute/path/to/gmap-place-saver/mcp/server.js"],
      "env": {
        "GMAP_HOME": "/absolute/path/to/gmap-place-saver",
        "GOOGLE_MAPS_PROFILE": "/absolute/path/to/google-maps-profile"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add gmap -- node /absolute/path/to/gmap-place-saver/mcp/server.js
# then set GMAP_HOME and GOOGLE_MAPS_PROFILE in the server's environment
```

**Generic MCP / Hermes** (`mcp_servers`):

```yaml
mcp_servers:
  gmap:
    command: "node"
    args: ["/absolute/path/to/gmap-place-saver/mcp/server.js"]
    env:
      GMAP_HOME: "/absolute/path/to/gmap-place-saver"
      GOOGLE_MAPS_PROFILE: "/absolute/path/to/google-maps-profile"
    timeout: 180
```

### Tools

| Tool | Description | Touches the browser |
|---|---|---|
| `resolve_place` | URL/text → one candidate + `savePayload` (or `needsBrowserSnapshot`) | only on the weaker path |
| `save_place` | Save a confirmed candidate to the exact regional list (`dryRun` supported) | yes |
| `attach_note` | Attach a note to the exact place, else write a sidecar record / refuse | yes |
| `list_regions` | Return the region → list mapping | no |
| `benchmark_summary` | Summarize resolver/save performance | no |
| `smoke_check` | Safe diagnostics (node, Playwright, profile, region config) | no |

## CLI

```bash
gmap-place resolve '<instagram/maps url | place text>'
PLACE_QUERY='…' LIST_NAME='Taipei' EXPECTED_NAME='…' DRY_RUN=1 gmap-place save
PLACE_URL='…' EXPECTED_NAME='…' SOURCE_URL='…' RECOMMENDATION='…' gmap-place attach
gmap-place regions
gmap-place benchmark 100
```

## Safety guarantees

- A candidate is always confirmed before any save (`resolve` and `save` are separate).
- Saves go only to the exact matching regional list — never a silent fallback.
- A note is attached only when the page title **and** the note field's nearest
  ancestors both confirm the exact place; otherwise it is written to a local
  sidecar JSONL record or refused.
- No Google credentials are requested or stored; a persistent profile is used.
- Tool output is compact JSON with privacy-safe snippets only.

## Development

```bash
npm test            # unit tests + MCP integration test + syntax gate
npm run smoke:resolve   # needs network (and the profile for the slow path)
npm run mcp         # run the MCP server on stdio
```

Architecture: pure logic (config, social parsing, note scoring, recommendation)
lives in small unit-tested modules; browser automation (`candidate`, `save`,
`note`) are importable async functions; the MCP server and CLI both call the same
core — no child-process spawning between layers.

## License

[MIT](LICENSE)
