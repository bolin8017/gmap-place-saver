# Comprehensive repo review — 2026-07-22

Deep review pass over every subsystem (resolve, maps, core+storage, entry
points, docs/tests/hygiene). Every finding below was verified by re-reading
the cited code; findings marked `[tested]` were additionally reproduced
empirically in a sandbox (never against live user data). Severity: **H** =
user-visible breakage or data loss on realistic input, **M** = silent
misbehavior or broken contract, **L** = edge case or hygiene. Findings that
could not be reproduced without a real browser session are capped at M.
`[security]` findings sort first within their band.

## Cross-cutting themes

1. **Success is over-reported at every layer.** `savePlace` builds
   `successLikely` from click *attempts* rather than verified state, the CLI
   exits 0 on failed saves/notes, and the MCP server returns non-error
   results for failed actions. A caller can currently never distinguish
   "saved" from "probably didn't save" without parsing heuristic fields.
2. **The docs promise more safety than the code delivers.** README's
   "Safety guarantees" say a region is never silently mis-routed, but list
   routing is first-match-wins with no ambiguity detection; the documented
   `cp .env.example .env` workflow does nothing because no code loads `.env`;
   two behavior-changing env vars are undocumented.
3. **Safety-critical pure logic is untested, and nothing runs the tests.**
   There is no CI workflow at all. Region routing (the headline safety
   feature) has zero unit tests and exists as two divergent implementations.
4. **The cache layer is fragile.** Failed resolutions are cached forever,
   writes are non-atomic read-modify-write, and one write path is dead code.

## Findings by subsystem

### ci — repository tooling

- **ci-1 (M)** — no file — Tests exist (28 passing) but there is no CI
  workflow (`.github/` is absent entirely) and no linter. Scenario: any
  regression — including in the untested routing logic below — merges green
  because nothing runs `npm test` on a PR. Fix: add a GitHub Actions
  workflow running `npm ci && npm test` on Node 18/20/22, plus
  `bash -n scripts/login-server.sh` (the repo's only shell script currently
  ships syntax-unchecked; `package.json:45` hand-lists JS files but skips
  it). This is the first roadmap item: later fixes need somewhere to put
  red tests.
- **ci-2 (L)** — `package-lock.json` (uncommitted drift) — A later npm
  added `bin.gmap-mcp` and `engines` to the lockfile root entry to match
  `package.json`; the change is benign but leaves a perpetually dirty tree.
  Fix: commit it.

### resolve — src/resolve/ (social.js, candidate.js, wrapper.js)

- **resolve-1 (H) `[tested]`** — `src/resolve/social.js:311` —
  `resolveSocial` caches every result unconditionally, unlike
  `resolveCandidate` which gates on `hasUsefulCandidate`
  (`candidate.js:256`). Scenario: one transient network failure produces
  `{confidence:'low', errors:[...]}`, which is persisted under the canonical
  URL key; every later call returns the poisoned entry with
  `cacheHit: true` even after the network recovers, so that post can never
  fast-path resolve again until the cache file is hand-edited. Reproduced:
  second call returned the cached failure. Fix: only cache results with a
  `placeName || address` and no fatal errors.
- **resolve-2 (M) `[security]`** — `src/resolve/social.js:82-83` — The
  source URL is passed to `yt-dlp`/`uvx` as a trailing positional with no
  `--` separator. Scenario: `resolveSocial` called directly (exported API,
  or `node src/resolve/social.js '--exec=…'`) passes an attacker-shaped
  value that yt-dlp parses as an option; `--exec` runs a shell command. The
  MCP path is protected only incidentally by `isSocialUrl` at
  `wrapper.js:60`. Fix: insert a literal `'--'` before the URL in both
  candidate arg arrays.
- **resolve-3 (M) `[tested]`** — `src/resolve/social.js:191` (duplicate
  logic `src/resolve/candidate.js:92`) — `inferTargetList` is
  first-match-wins with no multi-match detection, and `loadRegionEntries`
  (`social.js:174-181`) builds `new RegExp(keywords.join('|'))` without
  validating keywords. Reproduced both failure modes: a list with an empty
  keyword array yields the regex `(?:)` which matches **every** address, so
  that list captures all routing; overlapping keywords (`台北` in list A,
  `台北市` in list B) silently route to whichever key comes first in the
  JSON. Both contradict README:183-192 ("never silently saves to the wrong
  list") because the routed `targetList` flows unchanged into the
  high-confidence fast-path save payload (`wrapper.js:67-89`). Fix: reject
  empty/blank keywords at load; detect >1 matching list and force
  confirmation (`needsBrowserSnapshot`/explicit ambiguity flag); align the
  README wording; see test-1 for the missing coverage.
- **resolve-4 (M)** — `src/resolve/social.js:238-241`,
  `src/resolve/candidate.js:146-149` — Both caches are read-modify-write
  with a plain full-file `writeFile`: no temp+rename, no locking. Scenario:
  two concurrent resolves interleave and the second writer clobbers the
  first's new entry; a crash mid-write truncates the JSON, after which
  `readJson` silently falls back to `{}` and the entire cache is lost. Fix:
  write to a temp file then rename.
- **resolve-5 (L)** — `src/resolve/social.js:314` — Results are stored
  under both the canonical key and the raw trimmed URL, but reads only ever
  look up the canonical key (`social.js:255`), so the raw-URL entry is
  never read — pure cache bloat. Fix: drop the second write.
- **resolve-6 (L)** — `src/resolve/social.js:200` — With no
  placeName/address, `makeMapsQuery` falls back to the first 2–50-char
  caption line (e.g. "超好吃"), shipping a misleading `mapsQuery`/`mapsUrl`.
  Mitigated: `wrapper.js:97` returns `needsBrowserSnapshot` before any save
  in that case. Fix: leave the query empty at low confidence.

### maps — src/maps/ (save.js, note.js, maps-ui.js)

- **maps-1 (H)** — `src/maps/note.js:192-197` — `attachNote` selects all
  (`Ctrl+A`) and types over the note field without ever reading the
  existing value; `clearNote` (note.js:264) captures `previousText`, but
  `attachNote` does not. Scenario: the user hand-wrote a note ("訂位電話
  04-…") on a saved place; `attach_note` for that place silently destroys
  it — no sidecar record, no `previousText` returned, and the post-write
  verification succeeds because the *new* note is present. Deterministic
  from the code path (kept at H: this is guaranteed data loss whenever a
  note already exists, not a probabilistic selector issue). Fix: capture
  `sel.best.value` before typing; return it as `previousText`, and refuse
  (or sidecar) on a non-empty existing note unless explicitly overridden.
- **maps-2 (M)** — `src/maps/save.js:210`, `save.js:255` — `listClicked`
  is set to `true` on the click *attempt*; the honest signal
  (`ariaCheckedAfter`) only feeds `listAlreadySelected`, which
  `successLikely` ignores. Scenario: the row is clicked but the toggle
  doesn't register (overlay/race) → `aria-checked` stays false, yet the
  result reports `successLikely: true` and the place was never added. Fix:
  base `successLikely` on verified `aria-checked`/`listAlreadySelected`.
- **maps-3 (M) `[tested]`** — `src/maps/save.js:82`, `save.js:145` —
  URL-only saves (no `placeQuery`/`expectedName`) yield
  `expectedName === ''`, and `bodyAfterSearch.includes('')` is always true,
  so `placeFoundLikely` is trivially satisfied and the place-confirmation
  guard is silently disabled. Reproduced the string semantics. Fix: treat
  an empty `expectedName` as "cannot confirm".
- **maps-4 (M)** — `src/maps/note.js:59-64` — `openSavedList` picks the
  list via `:has-text("${listName}")`, a substring match. Scenario: lists
  「彰化」 and 「彰化市」 both match `has-text("彰化")` and the first visible
  one is clicked; if the wrong list contains a same-named place, the scorer
  accepts it (name match alone reaches threshold; the `targetList` check in
  `maps-ui.js:22` is only a +3 bonus, not a gate) and the note is written
  to — or cleared from — a place in the wrong list. Not reproduced (needs a
  live session), capped at M; confirming would require two lists with a
  shared name prefix in a test account. Fix: exact-text list matching, and
  make the `已儲存於「…」` confirmation a gate.
- **maps-5 (L)** — `src/maps/save.js:182,185,199`, `src/maps/note.js:60-63`
  — `listName` is interpolated raw into Playwright selector strings; a name
  containing `"` breaks the selector. In note.js the error is swallowed by
  `clickFirstVisible`, so every note quietly routes to sidecar with a
  misleading "not found" reason. Fix: use `getByText(listName,
  { exact: true })` / `hasText` string form.
- **maps-6 (L)** — `src/maps/note.js:36-37` — `clickFirstVisible` swallows
  click errors (`.catch(() => {})`) and still returns the selector as if
  the click succeeded, so `openSavedList` proceeds against an unopened
  panel and the failure surfaces later with a wrong reason. Fix: return
  null / propagate on actual click failure.
- **maps-7 (L)** — `src/maps/note.js:23-28`, `note.js:202` — Verification
  requires `verify.best.value.includes(marker)`; for an explicit `noteText`
  the marker is the first 20 chars, so any whitespace normalization by the
  textarea causes a false negative → a duplicate sidecar record for a note
  that actually attached. Fix: normalize both sides before comparing.

### core — src/config.js, smoke.js, storage/

- **core-1 (M) `[tested]`** — `src/config.js:18-19` —
  `Number(env.GMAP_RETRIES ?? 2)`: `??` doesn't guard the empty string, so
  `GMAP_RETRIES=""` (a blanked tuning line) yields `0` retries and
  `GMAP_RETRY_MIN_TIMEOUT_MS=""` yields `0`ms; garbage yields `NaN` passed
  into pRetry. Reproduced (`retries: 0`). Fix: parse with a
  `Number.isFinite` fallback.
- **core-2 (M) `[tested]`** — `src/storage/benchmark.js:22-23` —
  `benchmarkSummary` has no ENOENT guard and no per-line JSON guard.
  Reproduced: on a fresh install the `benchmark_summary` MCP tool and
  `gmap-place benchmark` (both advertised as safe, no-browser) throw ENOENT
  instead of returning an empty summary; one corrupt JSONL line rejects the
  whole summary. Fix: missing file → empty summary; skip unparseable lines.
- **core-3 (M)** — `src/smoke.js:33` — `ok = regionConfigReadable` only,
  so `smoke_check` reports `ok: true` with Playwright missing and the
  profile absent; the user's next save fails at browser launch despite a
  green smoke check. Fix: expose `browserReady` and fold it into `ok`, or
  rename `ok` to `regionConfigOk`.
- **core-4 (L)** — `src/storage/sidecar.js:6-7` — `sidecarFileFor` slices
  `createdAt` assuming ISO; an explicit `"2026/06/21"` becomes the file
  `2026/06.jsonl`, i.e. an unintended subdirectory. Fix: normalize to ISO
  before slicing.
- **core-5 (L)** — `src/config.js:7` — Default `home = PKG_ROOT` writes
  caches/logs/sidecar inside the installed package directory, which breaks
  on read-only/global installs. Documented behavior, so hygiene only.

### entry — mcp/server.js, bin/gmap-place.js, scripts/

- **entry-1 (M) `[security]`** — `scripts/login-server.sh:43,47` — Xvfb
  runs with `-ac` (X access control disabled) and x11vnc with `-nopw`.
  `-localhost` keeps both off the network, but on a **multi-user** server
  any local user can attach to display :99 or 127.0.0.1:5901 and watch or
  drive the interactive Google login. Fix: drop `-ac`, add x11vnc
  `-rfbauth`/MIT-MAGIC-COOKIE auth; at minimum document the exposure.
- **entry-2 (M)** — `bin/gmap-place.js:23-56` — `save` exits 0 even when
  `successLikely: false`, and `attach`/`clear-note` exit 0 on
  `{ok: false}` (`savePlace`/`attachNote` return failure objects without
  throwing). Scenario: `gmap-place save && next-step` proceeds on a save
  that never happened; inconsistent with `resolve`, which exits 1 on
  errors. Fix: exit non-zero when the action result reports failure
  (excluding dry runs).
- **entry-3 (M)** — `mcp/server.js:16-18` with tools at `:32-69` — `run()`
  sets `isError` only on a thrown exception, so `save_place` returning
  `successLikely: false` and `attach_note`/`clear_note` returning
  `ok: false` are framed as successful tool results; an agent that doesn't
  parse the JSON body treats a failed save as saved. Fix: map
  `successLikely === false` / `ok === false` to `isError: true`.
- **entry-4 (M)** — `scripts/login-server.sh:43-55` — Backgrounded
  Xvfb/x11vnc/noVNC failures are invisible: `set -e` never fires for `&`
  jobs and the PIDs are never health-checked, while `:99`/5901/6080
  defaults collide on shared servers. Scenario: Xvfb dies on a port/display
  collision, the script still prints a working-looking noVNC URL, then
  login runs against a dead or foreign display. Related hygiene: fixed
  `sleep 1` readiness races; `${USER}` may be empty in the printed SSH
  hint. Fix: `kill -0` + port-listen checks after each start, fail loudly
  with the log tail; poll readiness instead of sleeping.
- **entry-5 (L)** — `scripts/login.js:26`, `src/maps/save.js:95` (et al.)
  — `--no-sandbox` on every Chromium launch reduces browser isolation;
  standard for containers but worth one README line.

### docs — README.md, .env.example, .gitignore

- **docs-1 (M) `[tested]`** — `README.md:43` vs the whole codebase — The
  documented install step `cp .env.example .env  # then edit
  GOOGLE_MAPS_PROFILE` has **no effect**: no code loads `.env` (verified —
  no `dotenv` dependency, no `--env-file`, no reference to the file outside
  the docs). Scenario: a CLI user follows Install exactly, edits `.env`,
  and every browser command fails with "GOOGLE_MAPS_PROFILE not set". The
  MCP examples work only because they pass env explicitly. Fix: load `.env`
  (e.g. `dotenv` or Node's `--env-file`) or rewrite Install/Configuration
  to say variables must be exported. Interacts with core-1 (a loaded
  `.env.example` blanks `GMAP_CACHE=` etc. — harmless for `||` defaults but
  `GMAP_RETRIES` must be fixed first or removed from the template).
- **docs-2 (M)** — `src/config.js:21-22` vs `README.md:75-86` /
  `.env.example` — `HEADLESS` (`=0` runs headed — the only way to debug a
  save visually) and `GMAP_FAST_SOCIAL` (`=0` disables the fast path) are
  read but documented nowhere, despite README:72 claiming all tuning is in
  `.env.example`. Fix: add both to the table and template.
- **docs-3 (L)** — `.env.example:5` — Still says login is "added in a
  later PR" though `scripts/login.js` is committed; `scripts/login.js:34`
  reads undocumented `START_URL`. Fix: refresh the comments.
- **docs-4 (L)** — `.gitignore:6` — Blanket `*.png` silently makes any
  future README screenshot un-committable; `logs/` is already ignored. Fix:
  scope or remove.
- **docs-5 (L)** — `package.json:46-47` — `smoke:candidate` embeds a real
  business address and `smoke:resolve` a real Instagram reel URL. It is a
  business (bakery), not a residence — no personal-data leak; optionally
  swap for placeholders.

### test — test quality

- **test-1 (M)** — `src/resolve/social.js:174-194`,
  `src/resolve/candidate.js:92-98` — The region-routing decision — the
  README's headline safety feature — has zero unit tests, and exists as two
  divergent implementations with different signatures, neither pinned.
  Scenario: a refactor changes match ordering in one copy; all 28 tests
  still pass while saves route to the wrong list. Fix: unit-test both
  routers, including the empty-keyword and overlapping-keyword cases from
  resolve-3 (fixing resolve-3 adds these as red tests first).
- **test-2 (L)** — `test/smoke.test.js:19` — `typeof x === 'boolean'`
  assertions cannot fail meaningfully. Also untested load-bearing logic:
  `verificationMarker` (note.js:23), the scorer's demotion branch
  (maps-ui.js:31), `successLikely` composition (save.js:255). Fix: pin
  them alongside their fix batches.

Dimension 4 (cross-platform/multi-engine parity): no findings beyond the
login-server.sh items above — the tool is intentionally Linux-first and the
only parity surface (darwin `Meta+A` vs `Control+A`, note.js:194) is
handled.

## Roadmap

Batches in execution order (severity first; each batch = one concern = one
future PR; all independent unless noted). Fix mode enters only after this
report is approved.

| # | Batch (branch) | Findings | Size est. |
|---|---|---|---|
| 1 | `ci/add-workflow` — CI running tests on Node 18/20/22 + `bash -n`; commit lockfile drift | ci-1, ci-2 | S (enabler; exempt from test-first) |
| 2 | `fix/attach-note-preserve-existing` — capture & return `previousText`, refuse/sidecar on non-empty existing note | maps-1 (H) | S |
| 3 | `fix/social-cache-poisoning` — cache only useful results; drop dead raw-URL write | resolve-1 (H), resolve-5 | S |
| 4 | `fix/ytdlp-arg-separator` — `--` before URL | resolve-2 (M, security) | XS |
| 5 | `fix/login-server-hardening` — X/VNC auth, liveness + readiness checks | entry-1 (M, security), entry-4 | M |
| 6 | `fix/region-routing-ambiguity` — keyword validation, multi-match ⇒ confirmation, unit tests for both routers, README wording | resolve-3, test-1, README claim | M |
| 7 | `fix/save-success-verification` — `successLikely` from `aria-checked`; empty `expectedName` ⇒ cannot confirm | maps-2, maps-3 | S |
| 8 | `fix/surface-action-failures` — CLI non-zero exit + MCP `isError` on failed actions | entry-2, entry-3 | S |
| 9 | `fix/config-env-honesty` — load `.env` (or fix docs), numeric env guard, document `HEADLESS`/`GMAP_FAST_SOCIAL`, refresh stale comments | docs-1, docs-2, docs-3, core-1 | S |
| 10 | `fix/benchmark-robustness` — ENOENT ⇒ empty summary; skip corrupt lines | core-2 | XS |
| 11 | `fix/atomic-cache-writes` — temp+rename for both caches | resolve-4 | S |
| 12 | `fix/note-targeting-robustness` — exact-text list matching, honest click failures, marker normalization | maps-4, maps-5, maps-6, maps-7 | M |
| 13 | `fix/diagnostics-honesty` — smoke `ok` semantics; strengthen tautological assertions | core-3, test-2 | S |
| 14 | `chore/hygiene-sweep` — sidecar date normalization, `.gitignore` png scope, `--no-sandbox` README note, low-confidence query fallback, placeholder smoke data | core-4, core-5, docs-4, docs-5, entry-5, resolve-6 | S |

Batch 9's `.env` decision (load it vs. document-only) is the one
requirement-level choice in the roadmap; the batch will default to loading
it via Node's built-in `--env-file`-compatible parsing (no new dependency)
unless directed otherwise.
