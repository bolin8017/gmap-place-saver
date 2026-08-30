# Comprehensive repo review — 2026-08-30

Quick pass (riskiest subsystems only: live deployment, LINE bot, maps
actions; dimensions 1–3). Follows up the 2026-07-22 deep review — every
finding from that round is merged and verified fixed; nothing below is a
repeat. Every finding was verified by re-reading the cited code; findings
marked `[tested]` were additionally reproduced empirically in a sandbox or
against live diagnostics (never against user data). Severity: **H** =
user-visible breakage or data loss on realistic input, **M** = silent
misbehavior or broken contract, **L** = edge case or hygiene.

Baseline: `npm test` green — 140 tests pass, `npm run check` clean, CI runs
on Node 22/24. No secrets tracked; `.gitignore` correctly covers `.env`,
`users/`, `cache/`, `logs/`, `data/`, and the private region config.

## Cross-cutting themes

1. **The bot has been down for two weeks and nothing said so.** The
   Cloudflare quick tunnel died server-side on ~2026-08-16; cloudflared
   stayed alive retrying, so systemd's `Restart=on-failure` never fired, the
   webhook endpoint at LINE still points at a hostname that no longer
   resolves, and no alert exists for "reachable from the outside". Every
   other layer of this project verifies its own success from read-back
   state; the deployment is the one layer that verifies nothing.
2. **The sign-in fix stopped one step short.** #30 taught `savePlace` and
   `unsavePlace` to recognise an expired Google session — but the step that
   actually runs first is `resolveCandidate`, which computes
   `signInVisible` and then nobody reads it. An expired session therefore
   still reaches the friend as 「這個連結我讀不出店家資訊」 with no admin
   alert: exactly the failure mode #30 set out to make visible.
3. **Operator-facing writes report success from the happy path.** The
   runtime code is disciplined about never claiming an unverified success;
   `onboardUser --share-with` is not, and tells the operator it linked two
   accounts in a case where it silently did nothing.

## Findings by subsystem

### ops — live deployment (systemd + Cloudflare quick tunnel)

- **ops-1 (H) `[tested]`** — live environment, root cause in
  `line/tunnel.js` — **The LINE bot is unreachable right now.** LINE has
  `https://bar-obligations-climb-unlock.trycloudflare.com/webhook`
  registered (`GET /v2/bot/channel/webhook/endpoint` → `active: true`), and
  that hostname no longer resolves (`curl` exits 6). The local server is
  healthy (`127.0.0.1:3080/healthz` → 200), so every message a friend sends
  is dropped at Cloudflare with no error anywhere the operator would look.
  Evidence: cloudflared PID 2288321 has run since Aug 14 22:57 and logged
  ~5,300 `ERR Serve tunnel error` lines/day since Aug 16 (`journalctl --user
  -u gmap-line-tunnel`). Immediate fix: `systemctl --user restart
  gmap-line-tunnel` — a fresh quick tunnel is created and re-registered.
  Durable fix: ops-2 + ops-3.
- **ops-2 (H)** — `line/tunnel.js:53,57,66` — `registered` latches to `true`
  after the first successful registration and is never reset, so
  `onOutput` early-returns for the rest of the process's life. Scenario:
  cloudflared reconnects with a new quick-tunnel hostname (its normal
  behaviour after a server-side teardown) and prints it; the supervisor
  ignores the line, LINE keeps the dead endpoint, and the bot is silently
  offline until someone restarts the unit by hand. This is what happened in
  ops-1. Fix: track the last registered URL instead of a boolean, and
  re-register whenever `extractTunnelUrl` yields a different one.
- **ops-3 (M)** — `line/tunnel.js:45-50` +
  `scripts/gmap-line-tunnel.service.example:17` — the supervisor exits only
  when cloudflared exits, and cloudflared does not exit while it is
  reconnect-looping, so `Restart=on-failure` cannot recover the tunnel. No
  code path ever asks "is the endpoint LINE knows about actually serving?"
  Fix: after registering, poll the registered URL's `/healthz` on an
  interval; on N consecutive failures kill cloudflared and exit non-zero so
  systemd restarts the pair with a fresh hostname (and, given
  `LINE_ADMIN_USER_ID` already exists for session alerts, push an admin
  message on the way out).
- **ops-4 (L)** — `README.md:245-246` and
  `scripts/gmap-line-tunnel.service.example:6-7` — both claim the tunnel
  "re-registers the channel's webhook endpoint … every time the temporary
  hostname changes". It registers exactly once per process (ops-2). Fix
  with ops-2, so the sentence becomes true rather than being deleted.
- **ops-5 (L)** — the user journal holds 590.8 MB, dominated by the tunnel's
  ~5,300 error lines/day since Jul 31. Journald's own caps keep this
  bounded, but it buries every other service's history. Largely resolved by
  ops-3 (a looping tunnel gets restarted instead of logging forever).

### line — LINE bot (line/)

- **line-1 (M) `[tested]`** — `line/handlers.js:78-80`,
  `src/resolve/candidate.js:245,257`, `src/resolve/wrapper.js:117-147` —
  an expired Google session hit during the **resolve** step is invisible.
  `resolveCandidate` computes `signInVisible` and stores it on the
  candidate; `resolvePlace` never lifts it into `confirmation`; `handleUrl`
  only ever inspects `resolved.confirmation`. Scenario: the session expires,
  the friend sends an IG link, the browser lands on the sign-in wall, no
  title/address come back, and she is told 「這個連結我讀不出店家資訊 😢
  可以改傳 Google Maps 的店家連結試試」 — advice that cannot possibly work —
  while the admin is never alerted. Reproduced with a fake `resolvePlace`
  returning `candidate.signInVisible: true`: reply was the resolve-failed
  text, `push` to the admin never fired. Fix: surface `signInVisible` on the
  `resolvePlace` result, branch on it in `handleUrl` before
  `resolveFailedMessage` (reusing `sessionExpiredMessage` + `notifyAdmin`),
  and switch `candidate.js:245` to `signInRequired({ url, … })` so it
  detects the accounts.google.com redirect the way `save.js:353` does.
- **line-2 (M) `[tested]`** — `line/user-store.js:82-86` — `onboardUser`
  with `--share-with` swallows `EEXIST` from `fs.symlink` on the assumption
  that the path is already the right symlink. If the user was onboarded
  standalone first, the path is their own real directory: no link is made,
  the allowlist is nevertheless written with `sharesWith`, and
  `line/onboard.js:22` prints "Sharing <id>'s Google account — no extra
  login needed." Scenario: a couple sharing one burner account — the second
  person keeps saving into her own (never-logged-in) profile while the
  operator believes the accounts are joined. Reproduced in a temp tree:
  `allowlist[B].sharesWith === A` while `lstat(users/B).isSymbolicLink()`
  is false. Fix: on `EEXIST`, `lstat` the path and accept it only when it
  is a symlink already pointing at `shareWith`; otherwise throw and name
  the conflict.
- **line-3 (L)** — `line/handlers.js:82-85` — the "already saved" dedupe
  runs before `queue.push`, so two copies of the same URL sent seconds
  apart both pass and both queue. **Corrected while fixing (2026-08-30):**
  the first draft of this finding said both then save; writing the test
  showed the queued job already re-checks `findHistory`, so the common path
  was covered. The real gap is that the re-check matches on `mapsUrl` only —
  a candidate resolved to an address+name query has none, so it saved twice
  and wrote a second history row with its own undo button. Fix: re-check the
  source url too, which every job has.
- **line-4 (L)** — `line/handlers.js:92-93` — every candidate card writes
  a `cancel` pending record that is only consumed if the friend taps
  「先不存」. A confirmed save leaves it in `data/line-pending.json` for the
  30-minute TTL. Harmless (`put` prunes expired records), noted only
  because it makes the file misleading to read during debugging.

### maps — save / unsave / note (src/maps/)

- **maps-1 (M)** — `src/maps/save.js:306-310` — the create-list branch is
  the one place in this subsystem that reports failure by throwing instead
  of by result fields: `nameBox.waitFor` rejects, `savePlace` propagates,
  and the caller gets an exception after 「新增清單」 has already been
  clicked — which, when Google's dialog drifts, creates a stray
  「未命名清單」 in the account. Evidence that this is not hypothetical:
  `logs/failures/2026-08-17T12-46-08-014Z-save-place-to-list.json` caught
  exactly this, ending on `未命名清單 - Google 地圖` with `清單空白`. The
  specific drift that caused that run was fixed the same evening by #29
  (7648cf8), but the shape remains: a future dialog change produces an
  exception plus an orphan list rather than a `listCreated: false` result
  the LINE layer could explain. Fix: catch around the name-box wait, return
  the normal result object with `listCreated: false` and a reason, and log
  that a stray list may need cleaning up.
- **maps-2 (L)** — `mcp/server.js` — `unsave_place` is not registered as an
  MCP tool although `save_place`, `attach_note` and `clear_note` are, and
  `src/maps/unsave.js` is production code the LINE bot depends on. An agent
  can save through MCP but has to shell out to `bin/gmap-place.js unsave` to
  undo. Fix: register it with the same strict schema as `save_place`.

### config & docs

- **cfg-1 (L)** — `src/config.js:56` — `GMAP_HISTORY_FILE` is read by
  `loadConfig` but appears in neither `.env.example` nor `README.md`;
  `GMAP_LINE_PORT` and `GMAP_USERS_DIR` are in `.env.example` but missing
  from the README env table. Fix: add all three to the README table and
  `GMAP_HISTORY_FILE` to `.env.example`.

### Dimensions not covered in this pass

- Cross-platform / multi-engine parity: not applicable — single runtime
  (Node ≥22 on Linux), CI already covers 22 and 24.
- Test quality: not re-examined this round; the 2026-07-22 pass rebuilt it
  and the suite has grown from 28 to 140 tests with every fix since landing
  its own red test first.
- CI & tooling hygiene: no findings — `npm test` runs the suite plus
  `node --check` over every entry point and `bash -n` over the shell script,
  on both supported Node majors.
- Security basics: no findings — no secrets tracked, LINE user ids are
  validated before use as path segments, per-user trees are 0700, webhook
  signatures are verified before any parsing, and the body is capped at 1 MB.

## Roadmap

Batches are ordered by severity and are independent of each other unless
noted; one batch = one concern = one PR.

1. **Restore the bot now** (operational, no code) — `systemctl --user
   restart gmap-line-tunnel`, then confirm the new hostname is registered
   and `/healthz` answers through it. Unblocks ops-1 today; batch 2 stops it
   recurring.
2. **`fix(tunnel): survive a hostname change and a dead tunnel`** — ops-2,
   ops-3, ops-4. Red test first on the re-registration logic (extract the
   URL-tracking out of `main()` so it is testable, the way `extractTunnelUrl`
   and `setWebhookEndpoint` already are). ~120 lines.
3. **`fix(line): report an expired session found while resolving`** —
   line-1. Red test in `test/line-handlers.test.js` using the repro above.
   ~60 lines.
4. **`fix(line): refuse a --share-with that would not actually share`** —
   line-2. Red test in `test/line-user-store.test.js`. ~40 lines.
5. **`fix(maps): report a failed list creation instead of throwing`** —
   maps-1. Red test in `test/save-success.test.js`. ~50 lines.
6. **`chore: dedupe race, pending hygiene, unsave tool, env docs`** —
   line-3, line-4, maps-2, cfg-1. Small and independent; split out if it
   grows past ~150 lines.

---

# Addendum — 2026-08-30 (second pass)

The pass above was `quick`: dimensions 1–3 over the riskiest subsystems. This
addendum covers what it left out — `src/maps/note.js`, `scripts/login.js`,
`scripts/login-server.sh`, `src/recommendation.js`, `src/storage/sidecar.js`,
and dimensions 4–7. Same rules: verified at the cited lines, `[tested]` where
reproduced.

## What running the fixes taught us

**ops-6 (H) `[tested]` — found by running the fix, not by reviewing it.**
`line/tunnel.js` — the give-up path added in #34 worked in every respect
except the one that mattered: it exited **0**. cloudflared handles SIGTERM
gracefully and exits 0, and that code was propagated straight through, so
systemd's `Restart=on-failure` saw a clean exit and did not restart. Every
give-up would have torn the tunnel down and left it down — turning a
recoverable outage into a permanent one, which is worse than the bug #34 set
out to fix. Reproduced live with an isolated instance and a deliberately
invalid LINE token (exit 0), fixed, and re-run (exit 1). Shipped as #39.

The lesson generalises: the unit tests asserted that the tear-down was
*ordered*, which was true. What none of them could see was what the service
manager made of the result. Any fix whose payoff is "the supervisor restarts"
needs one live run before it is believed.

## Findings

### login — scripts/login-server.sh, scripts/login.js

- **sec-1 (M) `[security]` `[tested]`** — `scripts/login-server.sh:81` — the
  one-time VNC password is passed to `x11vnc -storepasswd` as a **command-line
  argument**, so it appears in `/proc/<pid>/cmdline` — which is mode
  `-r--r--r--`, and `/proc` here is mounted with no `hidepid`. Any local user
  polling `ps` during that instant reads the password, and x11vnc is started
  `-forever -shared` (`login-server.sh:94`), so they can then attach to the VNC session and watch or
  drive the Google sign-in. The script's own header claims the opposite:
  "the VNC server with a random one-time password, so other local users on a
  shared server cannot watch or drive the login session." Verified: a process
  spawned with a secret in argv was read back in full from another shell, and
  `/proc` carries no `hidepid` option. Window is short (`-storepasswd` exits
  immediately) but the attacker controls the polling rate.
  Fix direction: keep the password out of argv — `x11vnc -passwdfile <file>`
  reads a plaintext password from a file, and the script already creates
  `mktemp` files at 0600. **Not fixed here: x11vnc is not installed on this
  machine, so no proposed fix could be verified. It must be tried on the
  login server itself before being believed.**
- **sec-2 (L) `[security]` `[tested]`** — `scripts/login-server.sh:41` —
  `mkdir -p "$PROFILE"` pre-creates the browser profile directory at the
  umask default (0775 under this machine's umask 002), and Chromium does
  **not** tighten a directory that already exists — verified by pre-creating
  one at 775, launching a persistent context into it, and finding it still
  775 afterwards. `line/user-store.js:72-73,104-106` is careful to chmod 0700 for
  LINE user homes; this path is not.
  Scope, measured rather than assumed: the session itself does **not** leak —
  all 5,352 files in a real profile are 0600, including `Cookies`,
  `Login Data`, `Local State`, `Web Data` and `Preferences`. What becomes
  readable to other local users is the directory listing plus seven 0664
  files, among them `Default/Accounts/Avatar Images/<gaia-id>` and
  `Default/Google Profile Picture.png` — i.e. the identity of the Google
  account, not access to it. Hence L, not H.
  Fix: `chmod 700 "$PROFILE"` immediately after the mkdir, mirroring
  `onboardUser`.

### maps — src/maps/note.js

- **login-3 (M) `[tested]`** — `scripts/login-server.sh` — found while
  building a harness to verify sec-1, which is the only reason it was found at
  all: the script could not be run on this machine. x11vnc refuses to start
  when `WAYLAND_DISPLAY` is set — "Wayland display server detected ...
  Exiting." — regardless of `-display` pointing at the Xvfb server the script
  started and verified two lines earlier, and Chromium would prefer Wayland
  over that display for the same reason. `logs/x11vnc.log` shows a working run
  on 2026-08-10, from a tty, where `WAYLAND_DISPLAY` is absent. So it has been
  broken the whole time for the way anyone would actually reach for it: the
  bot's admin alert hands the operator this exact command to recover an
  expired Google session, and it gets pasted into a desktop terminal. Fixed in
  #43 by unsetting `WAYLAND_DISPLAY`; verified before (exit 1) and after
  (exit 0, noVNC URL and password printed) on a live Wayland session.

- **note-1 (L)** — `src/maps/note.js:258-260` — `attachNote`'s catch-all funnels
  every exception into `fallback('exception: …')`, which under the default
  `safeAttachOrSidecar` mode returns `{ ok: true, noteStatus: 'sidecar' }`.
  `actionFailed` only inspects `ok`/`successLikely`, so a Playwright crash
  reaches the CLI as exit 0 and MCP as a non-error result. The sidecar record
  really is written and `reason` really does say `exception: …`, so nothing is
  fabricated — but a caller checking the documented failure signal cannot tell
  a safely-refused note from a browser that died. Fix direction: keep `ok`
  true (the sidecar is a real outcome) and add a distinct `noteStatus` for the
  crash path, or have `actionFailed` treat an `exception:` reason as failure.
- **note-2 (L)** — `src/maps/note.js:70-95,214,237` — `openSavedList` is called
  twice per attach (once to write, once to verify) and each call re-navigates
  to Maps and re-opens the list behind four fixed `waitForTimeout` sleeps
  totalling ~3.5s, plus up to 10 scroll rounds at 700ms in
  `findExactNoteInList` (`note.js:100-108`). Nothing is wrong; it is simply the slowest path in
  the project and the one least protected by tests. Noted for whoever next
  looks at attach latency.

### Dimensions 4–7

- **Cross-platform (4)** — no findings. Single runtime (Node ≥22 on Linux);
  `note.js:231,310` already branches `Meta+A`/`Control+A` for macOS, and
  `login-server.sh` documents its Debian/Ubuntu prerequisites and allows every
  tool path to be overridden by env.
- **Test quality (5)** — one observation, no finding. Every extracted pure
  predicate is tested (178 tests). What is untested by construction is the
  browser choreography in `note.js`, `save.js`, `unsave.js` and
  `candidate.js`, and `login-server.sh` beyond `bash -n`. That is a
  deliberate house style — no test fakes a Playwright page — and ops-6 above
  is the reminder of what it cannot catch.
- **CI & tooling (6)** — no findings. `npm test` runs the suite plus
  `node --check` over every entry point and `bash -n` over the shell script,
  on Node 22 and 24.
- **Security basics (7)** — sec-1 and sec-2 above. Otherwise unchanged from
  the first pass: no secrets tracked, LINE ids validated before use as path
  segments, webhook signatures verified before parsing, 1 MB body cap.

## Roadmap (addendum)

7. ~~**`fix(login-server): keep the profile directory private`** — sec-2.~~
   Shipped as #42.
8. ~~**`fix(login-server): keep the VNC password out of argv`** — sec-1.~~
   Shipped as #45. The caveat here said not to merge it on reasoning alone,
   and that held: x11vnc was fetched with `apt-get download` and unpacked
   locally (no root), so the fix could be tested. An RFB handshake probe
   confirmed the server offers security type 2 (VNC Authentication) under
   `-passwdfile` and type 1 (None) with no password option — the control that
   made the result mean something, since a silently unauthenticated VNC would
   have been worse than the leak.
9. ~~**`fix(note): distinguish a crashed attach from a refused one`** — note-1.~~
   Shipped as #44.
10. ~~**`fix(login-server): ignore the desktop's Wayland session`** — login-3.~~
   Shipped as #43.

Everything in both passes is now shipped except **note-2**, which was recorded
as an observation rather than a defect — the attach path is simply the
project's slowest and least test-covered, and nothing about it is wrong.
