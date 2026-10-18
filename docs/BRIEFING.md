# RBS' Planning Poker — BRIEFING

This document captures the shared baseline for the project, the local working environment, our collaboration workflow, and the testing strategy. It’s meant to be stable, concise, and actionable.

---

## 0) Purpose (short)

Lightweight online planning poker with real-time updates, simple UX, and optional persistence (snapshots). Server-rendered HTML + vanilla JS for minimal footprint; Spring Boot backend.

**Prod URL**  
https://planning-poker.at/

**Current production baseline**
Production commit `271f9f7`: single-interface room repolish, responsive mobile
corrections, refreshed DE/EN user documentation and compact public-page
typography. Recent release history is maintained in `CHANGELOG.md`.

---

## 1) Current Working Environment (Dev box)

> Keep this section accurate. When versions change, update here.

- **OS:** Windows (terminal: Git Bash)  
- **Editor:** VS Code  
- **VCS:** Git (remote origin)  
- **Build:** Maven Wrapper (`mvnw`)  
- **Runtime:** Java 25 (OpenJDK)  
- **Backend:** Spring Boot 4.1.1, WebSocket (server push), Thymeleaf views
- **Frontend:** vanilla JavaScript, server-rendered HTML; global stylesheet: `src/main/resources/static/styles.css`  
- **Tests:**  
  - Unit/Component: JUnit 6, Mockito
  - E2E/UI: Playwright (run separately)  
- **Deployment:** Koyeb with the `planning-poker.at` custom domain; GitHub `main` triggers production deployment
- **Persistence options:** in-memory; FTPS file store (JSON); DB/JPA currently **not used**  
- **Configuration:** `src/main/resources/application.properties` (+ optional profile overrides)

### 1.1 Quick commands

- Java: `java -version`  
- Maven wrapper: `./mvnw -v`  
- Node/Playwright (if needed): `node -v`, `npm -v`, `npx playwright --version`

---

## 2) Tech Stack (overview)

- **Language:** Java (backend), HTML/CSS/JS (frontend)  
- **Frameworks:** Spring Boot, Thymeleaf  
- **Realtime:** Spring WebSocket → client JS  
- **Testing:** JUnit 6, Mockito, Playwright (E2E)
- **Build:** Maven (Surefire for unit tests)  
- **Static assets:** `src/main/resources/static/**`  
- **Templates:** `src/main/resources/templates/**`  
- **Config files:** `src/main/resources/application*.properties`  
- **Feature flags:** `features.*` keys (see §3)

---

## 3) Configuration & Feature Flags

- **Base config:** `application.properties`  
- **Profiles:** currently minimal; prod runs with app defaults (DB off); local profile available for H2 if ever needed for local experiments.  
- **Persistence master switch:**  
  `features.persistentRooms.enabled=false` (No-Op persistence; **current default**)  
- **Snapshot debouncer:**  
  - `features.persistentRooms.snapshot.enabled=true|false`  
  - `features.persistentRooms.snapshot.debounceMs=1500`

**Rules**

- Keys must be **spelled exactly**; remove unknown/misspelled keys.  
- Keep sensible defaults; production overrides via env/profiles.  
- Do **not** hardcode tenant-specific URLs (e.g., JIRA base). Current UX accepts full JIRA links and extracts the issue key for display while preserving the full URL as the anchor target. A configurable base URL is tracked in the backlog.

---

## 4) Coding & Style Rules

- **English everywhere in code:** class names, method names, variables, inline comments, messages.  
- **Frontend styling:** all CSS centralized in `static/styles.css`. Avoid inline styles; consolidate into `styles.css`.  
- **Small, focused changes:** avoid mixing refactors with feature work.  
- **Reuse first:** prefer extending existing files over creating new ones.

---

## 5) Collaboration Workflow (Dev ↔ AI)

These rules keep iterations safe, quick, and easy to review.

### 5.0 Golden rule — Ask before you act
When in doubt, ask a clarifying question. Never guess. No “best-effort” patches without either the current file content or an explicit “unchanged” confirmation.

### 5.1 Kickoff checklist for every new chat/session
- Share the **current repo shape** to prevent guessing:  
  - Windows: `tree /F > tree.txt`  
  - Git Bash/WSL: `find . -type f | sort > tree.txt`  
  Attach/paste the relevant sections.
- Share **active config** (`application.properties` + the active profile file, if any).  
- State **what you want to change** (file path + goal).  
- State **constraints** (no new deps, CSS centralization, etc.).

### 5.2 Change workflow = small, reviewable steps
1. Confirm target file(s) and **exact block(s)**.  
2. Provide a **minimal patch/snippet** only for that block.  
3. You run/tests → report back → next small step.  

_No batching of unrelated edits. Prefer one change per step/commit._

### 5.3 State & assumptions policy
- **Ask-first rule.** If anything is ambiguous or I'm not 100% sure, I stop and ask a clarifying question. I do not guess or provide “best-effort” patches without confirmation.
- **No assumptions.** If current code may differ from memory, we first request the **actual “as-is”** (file tree, file content, or relevant fragment).
- **After pauses, re-confirm state** before proposing edits.

### 5.4 Snippet & diff policy
- Drop-in snippets only when the replaceable block is **uniquely identifiable**.  
- If not unique, either request the exact surrounding lines, or add one-time **BEGIN/END markers** to ease future patches.

### 5.5 Reuse before creating new files
- Check whether existing structures can host the change.  
- New files/folders/dependencies only when clearly beneficial.

### 5.6 Styling policy
- **All styles live in `styles.css`.**  
- Reuse existing tokens/classes; if adding a token, define it in `styles.css` and reference it.

### 5.7 Testing policy
- New logic → new/updated tests. Target: **~90% coverage** for core modules.  
- Fast unit loop: `./mvnw -q -DskipITs -DskipE2E test`

### 5.8 Config & feature flags
- Behavioral changes behind flags must include:  
  the property keys + defaults **and** an entry in **this** BRIEFING when introducing new flags.

### 5.9 Backlog & docs hygiene
- “Do later” items go to `docs/BACKLOG.md`.  
- Rules and conventions live here (`BRIEFING.md`) and, for UI rules, optionally `STYLE.md`.  
- New collaboration rules agreed during chats are **added here** as part of the same step.

### 5.10 Dependencies
- Keep the footprint small. Before adding a dependency: verify necessity, check alignment with the stack, and ensure no existing solution already fits.

### 5.11 BRIEFING integrity & safeguards
<!-- PROTECTED: BRIEFING CORE SECTIONS v2025-10-10 — §§4–6 + Appendix E must remain present -->
- The following sections are considered **core** and must not be removed:
  **§4 Coding & Style Rules**, **§5 Collaboration Workflow**, **§6 Playwright E2E Testing**, **Appendix E – Identity & Name Handling**.
- Commits that modify `docs/BRIEFING.md` must keep these sections present. Our pre-commit hook checks anchor headings & a minimal length.
- Quick restore: `git restore --source 188a16f -- docs/BRIEFING.md`

---

## 6) Playwright E2E Testing (Executive Summary)

We use **Playwright** (TypeScript) for end‑to‑end tests. The suite is designed to tolerate small DOM variations across profiles (local/prod/e2e). All UI quirks are encapsulated in helpers under `tests/utils/helpers.ts`.

- Quick start:
  ```bash
  npm ci
  npx playwright install --with-deps
  PP_BASE_URL=http://localhost:8080 npx playwright test -c playwright.config.ts --retries=1 --trace=retain-on-failure
  ```
- Prefer running the app with a **stable test profile**:
  ```bash
  java -jar target/planningpoker-<version>.jar --spring.profiles.active=e2e
  ```
- Build sanity check:
  ```bash
  npm run e2e:buildcheck   # runs: tsc -p tests/tsconfig.json --noEmit
  ```
- Useful helpers (import from `tests/utils/helpers.ts`): `ensureMenuOpen/Closed`, `clickByValue`, `revealNow`, `resetNow`, `revealedNow`, `readAverage`, `readNumericChips`, `pickTwoNumeric`, `setSequence`, `waitSequenceOn`, `waitSequenceSync`, `voteAnyNumber`.

For detailed instructions, troubleshooting, CI recipe, and full command list, see **`docs/E2E-TESTING.md`**.

---

## 7) Persistence & Snapshotting (summary)

- Live mutations happen in memory (`Room` / `Participant`).  
- A debounced snapshotter can call `RoomPersistenceService.saveFromLive(room, actor)` to keep a persistent mirror (when enabled).  
- With `features.persistentRooms.enabled=false`, a **No‑Op** implementation is wired so the app still boots.  
- FTPS JSON storage is the current persistence choice for saved rooms; DB/JPA code has been retired from runtime.

---

## 8) Deploy & Ops (short)

- **Deploy target:** Koyeb  
- **Production domain:** `https://planning-poker.at`; Koyeb currently terminates the active custom domain
- **Proxy handling:** forwarded headers are supported by the application; optional proxy/CDN examples do not describe an active Cloudflare requirement
- **Delivery:** pushes to GitHub `main` trigger the configured Koyeb deployment
- **Health:** `GET /healthz` returns `ok`  
- **Profiles:** minimal; prod uses defaults; DB/JPA disabled  
- **Logs:** concise; avoid noisy stack traces for expected flows

---

## 9) Security & Privacy (short list)

- Avoid leaking secrets in logs.  
- Passwords: BCrypt + optional pepper (see properties).  
- Validate/encode user-provided content (topic label/URL sanitized on render).  
- Do not pin tenant-specific URLs in code (e.g., JIRA base). Accept full links as input; configurable base URL is a backlog item.

---

## 10) Frontend Notes & Topic UX

- **Server-rendered HTML**, vanilla JS (no SPA).  
- Realtime via WebSocket; client applies state updates.  
- The shared full-width app header is rendered from `fragments/app-header.html`.
  Desktop shows branding and compact preference controls; mobile shows branding
  and the menu trigger.
- `ui-preferences.js` (`window.PPUI`) owns language and theme.
  `menu.js` alone owns menu open state, focus, backdrop, Escape handling and
  background locking.
- The color preference uses `planningpoker-theme`; supported themes are Light,
  Dark and System. Interface geometry and typography are shared by all users.
- **Topic input UX**:  
  - **Optimistic editing** for hosts (local input isn’t overwritten mid‑typing by async updates).  
  - If a **full JIRA link** is pasted, the UI **extracts and displays the issue key** while keeping the **full URL** as the anchor target.  

- All shared layout, themes and responsive styling remain centralized in
  `styles.css`; reuse its tokens and existing 768px breakpoint.

### 10.1 Room layout (mobile ≤ 768px)

- **Two-line layout on mobile**  
  Line 1: icon + name (left), status/vote chip (right).  
  Line 2: **host actions** (“Host / Spectator / Kick”), right-aligned, full width.  
  The second line is **visible only for hosts**.

- **Desktop layout**
  Participant actions remain in `.row-right`; voting controls, result display
  and participant vote chips retain their centered geometry.

- **Implementation notes**
  - Host actions use the existing `.row-actions` / `.has-row-actions` structure.
  - Responsive rules live in `static/styles.css` at the existing 768px boundary.

- **Chip/name alignment on mobile**  
  For rows with `.has-row-actions`, name and chip share a unified line box (`--pr-line`), chips use `inline-flex` + `vertical-align: middle`.  
  No `transform` hacks; alignment is stable across zoom/fonts.

- **Result row (stability)**  
  Before reveal, `#resultRow` keeps its vertical space but renders no text (`#resultRow.is-hidden { visibility: hidden; }`) to prevent layout jumps.


---

## 11) How to start the next session (TL;DR)

1) Paste **file tree** (or relevant excerpt).  
2) Paste **active `application.properties`** (+ current profile file, if used).  
3) Tell me **which file/block** you want to change.  
4) Mention **constraints** (no new deps, styling rules, etc.).  
5) I’ll respond with **one small patch**; you apply/run/tests; we iterate.

---

## 12) Known warnings & tooling notes

- **Mockito inline mock maker / agent**: JDKs may restrict dynamic agent loading in future. The warning is benign today. If needed later, add the Mockito Java agent per Mockito docs in test config.  
- Keep Spring test slices modern; favor Mockito/injection over heavyweight contexts.

---

## 13) WebSocket/Realtime policy

- **Stability first**: debounce/coalesce server pushes when user is actively editing.  
- **Reconnect/backoff**: client handles reconnects with exponential backoff; server treats reconnects idempotently.  
- **No mid‑typing overwrite**: optimistic UI protects active inputs; inbound state updates apply after edit ends.

---

## 14) Accessibility & i18n

- **i18n**: messages in `messages*.properties`; avoid hardcoded strings in templates/JS where a key exists.  
- **A11y**: icon buttons get aria‑labels; keyboard access maintained; contrast respected.

---

## 15) Backlog (pointer)

General backlog items are maintained in `docs/BACKLOG.md`; it contains open
work only. Completed work belongs in `CHANGELOG.md`. The single-interface room
repolish, subsequent responsive/UI fixes and documentation refresh are deployed
through `271f9f7`. They preserve the established room, voting, permission and
WebSocket contracts. No additional change request is active.



## ###########################################
## ##########+++++ Appendices +++++###########
## ###########################################

## Appendix A — Public surface (routes & sockets)

- `GET /` → Landing page  
- `GET /invite?roomCode=...` → Invite page (pre-fills hidden room field)  
- `POST /join` → Validates inputs, decides persistent/non-persistent, redirects to `/room`  
- `GET /room?roomCode=...&participantName=...` → Main room view  
- `GET /api/rooms/check?name=...` → Returns `true` if the name is already taken (when feature backed)  
- `GET /healthz` → Plain health probe (returns `ok`)  
- **WebSocket:** `/gameSocket` (origins controlled via `app.websocket.allowed-origins`)

---

## Appendix B — FTPS env reference (current persistence mode)

| Property key                         | Env fallback (if any) | Default | Notes |
|-------------------------------------|------------------------|---------|------|
| `app.storage.mode`                   | —                      | `ftps`  | Current mode selector |
| `app.storage.ftps.host`             | `DF_FTP_HOST`          | —       | FTPS host |
| `app.storage.ftps.port`             | `DF_FTP_PORT`          | `21`    | Port |
| `app.storage.ftps.user`             | `DF_FTP_USER`          | —       | Username |
| `app.storage.ftps.pass`             | `DF_FTP_PASS`          | —       | Password |
| `app.storage.ftps.base-dir`         | `DF_FTP_BASE`          | `rooms` | Root dir for JSON snapshots |
| `app.storage.ftps.passive`          | —                      | `true`  | Passive mode recommended |
| `app.storage.ftps.implicit-mode`    | —                      | `false` | Explicit FTPS by default |
| `app.storage.ftps.so-timeout-ms`    | —                      | `15000` | Control/data timeouts |
| `app.storage.ftps.data-timeout-ms`  | —                      | `20000` | 〃 |
| `app.storage.ftps.use-utf8`         | —                      | `true`  | Filenames/paths |
| `app.storage.ftps.debug`            | —                      | `true`  | Verbose logs (disable in prod if noisy) |

> Password hashing: `app.security.password.bcrypt-cost` (default 10), optional `app.security.password.pepper`.

---

## Appendix C — Concurrency guardrails (Room model)

- `Room` holds in-memory state; mutations happen on server.  
- List is a `CopyOnWriteArrayList`, but **external code should still synchronize on the Room** when performing multi-step mutations to keep snapshots consistent.  
- Use provided methods (`addParticipant`, `removeParticipant`, `renameParticipant`, `reset`, …). Don’t expose or mutate internal collections directly.

---

## Appendix D — Quick test commands

- All unit tests:  
  ./mvnw -q -DskipITs -DskipE2E test

- Single test class:
  ./mvnw -q -DskipITs -DskipE2E -Dtest=StoredRoomPersistenceServiceTest test

- With logs (noisy, for debugging):
  ./mvnw test -X

---

## Appendix E – Identity & Name Handling

### Current identity authority

The room server, not a display name or browser-generated ID, owns participant
identity. Each live `Room` has one `RoomIdentityRegistry`. A new participant gets
a server-generated room-instance UUID, participant UUID and 256-bit resume token;
the registry stores only the token hash. The participant UUID is the internal
GameService lookup key. Display names remain unique per live room but are never
authentication credentials.

The `/gameSocket` admission protocol is versioned JSON. A `newJoin` receives an
`identityGrant`; the browser persists it and acknowledges with `identityAck` before
the participant becomes active. A `resume` must present the complete proof. After
successful admission the server sends `identityReady` and a nonce-based
`identityChallenge`; only the current connection owner may renew its 45-second
lease or issue room commands. Concurrent sockets, stale callbacks and late commands
cannot take ownership from the active generation.

### Browser storage and migration

`identity.js` stores one proof per room under `pp-identity-v2:<roomCode>`, preferring
`localStorage`, then `sessionStorage`, then memory for current-page continuity. The
fallback mode is visible to the user because it limits restart recovery. Proofs are
never placed in URLs, form fields, name checks, debug history or logs.

Legacy `pp-cid` and `pp-pf-ok:*` session entries are deleted during bootstrap and
are never read for admission. There is deliberately no CID compatibility fallback.
Existing legacy clients therefore perform a deliberate new join after rollout.
The migration changes no FTPS room path or stored room snapshot format; identity
proofs and ownership leases are live, instance-local state and are not restored
from snapshots.

### Entry, rejoin and exit rules

- Home, invite, direct room entry, refresh and Back all converge on the same
  server-authenticated WebSocket path. HTTP rendering and name-availability checks
  are advisory and never grant room access.
- A valid proof restores the same participant, vote and spectator state. It does
  not restore a host role that was transferred while the participant was away.
- Invalid, expired, revoked or wrong-room-instance proofs require an explicit new
  join. A matching display name alone cannot resume or take over a participant.
- An active owner causes `activeElsewhere`; the second socket does not displace it.
- `intentionalLeave` is proof-bound and acknowledged with `exited`. Lost
  acknowledgements are retried safely. Exit, kick and room closure revoke the proof.
- Name availability and suggestions use the live Room state, including pending
  grants. The WebSocket admission remains the final atomic uniqueness check.

### Acceptance criteria

1. Refresh, Back, short reconnect and browser/PWA restart with a valid stored proof
   resume exactly one participant and preserve vote/spectator state.
2. Parallel connections, foreign/invalid/revoked proofs and display-name-only
   attempts cannot take over an existing participation.
3. Explicit exit or kick prevents proof reuse; a subsequent join receives a fresh
   participant identity and normal defaults.
4. Host transfer is retained across the former host's rejoin; a recreated room code
   never accepts a proof from the previous room instance.

Implementation and rollout evidence are maintained in
`docs/PARTICIPANT-IDENTITY-REJOIN.md`.

