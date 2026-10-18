# Participant identity and rejoin implementation

Current status: steps 1–4 and the automated part of step 5 are completed on the
feature branch. The physical iPhone/PWA check and step 6 remain.
No production rollout is approved by completion of this step.

## Step 1: isolated identity core (completed)

Branch: `fix/participant-identity-rejoin`.

At the end of step 1, `RoomIdentityRegistry` was an unconnected component for one live room
instance with no application callers (it is not a Spring bean). At that point, CID,
HTTP/WebSocket, browser storage, participant lifecycle and gameplay behavior are
unchanged. Step 1 did not fix the reported PWA/form rejoin bug by itself.

The registry owns random room-instance and participant IDs. Keeping these IDs in
this isolated component for now avoids changes to model serialization and the
existing rename paths. Step 2 must attach exactly one registry to each live Room
and bind each issued participant ID to the corresponding server-side participant.
Names are not identity keys. Rename must preserve this binding.

Implemented guarantees:

- Server-generated 256-bit SecureRandom resume tokens; only SHA-256 hashes are
  retained in registry entries. Credential string rendering redacts the token.
- Credentials are bound to a room instance and participant ID. A new registry
  never accepts credentials from an earlier instance, even with a reused room code.
- One connection owner per participation. Claims are atomic and do not displace
  an owner with a valid lease, including repeat claims using the same socket ID.
- Successive ownership generations fence late commands, heartbeats and disconnects.
- A monotonic clock and a 45-second lease; expiry is exclusive of the deadline
  (at exactly 45 seconds the owner is invalid). Late renewals cannot revive it.
- Disconnect releases ownership but preserves the credential. Revocation removes
  the credential and owner. Closing the registry permanently prevents issuance.
- `runIfOwner` checks authorization and executes a synchronous mutation under the
  supplied room monitor, preventing a check/mutation race.

## Integration contract established in step 1

- Use the same Room monitor as GameService for join, identity mapping, name
  reservation, revocation and game-state mutation. Never create two registries
  for one live Room or copy a registry to a recreated Room.
- Treat Ownership handles as trusted server-side connection metadata, never as
  client-provided authorization. Resume credentials alone do not authorize commands.
- Authenticate heartbeat responses before calling `renew`. Implement the server
  challenge/sweep and bounded reconnect UX in step 2; this core has no scheduler.
- Close displaced/expired sockets outside the monitor, after ownership is fenced.
  Guard all presence/host timers with room identity and ownership generation.
- Revoke before freeing a name in the same room transaction. Keep host transfer
  and participant removal in GameService, not in the registry.
- Never serialize/log a Credential as a generic payload. Redacted `toString` is
  defense in depth, not a substitute for removing raw message/URI logging.
- Complete initial token delivery/acknowledgement and pending-join cleanup before
  exposing issuance. Do not preserve old CID authentication as a fallback.
- Do not persist this registry or restore it from snapshots. Client storage,
  newJoin/resume messages, explicit exit acknowledgement and migration are later work.

## Targeted validation

Command:

```powershell
.\mvnw.cmd '-Dtest=RoomIdentityRegistryTest,GameServiceNameTests,RoomTest' test
```

Result: **19 tests passed**, no failures/errors/skips (13 new core tests and
6 existing room/name/rejoin tests). No full suite or browser tests were run.

Coverage: room/participant/token mismatch, malformed credentials, redacted string
output, active-owner rejection, exactly one winner for concurrent claims,
disconnect/rejoin, generation fencing, exact expiry boundary, heartbeat renewal,
expiry sweeps, final revocation, closure/recreation, shared transaction monitor,
invalid ownership handles and monotonic-clock wraparound. Time tests use an
injected clock without sleeps; concurrent claims use a start barrier.

## Remaining approved plan after step 3 (requires separate authorization)

5. Run focused backend and Chromium/WebKit integration checks; manual iPhone PWA check.
6. Update final architecture/API/user/deployment docs and prepare a controlled rollout.

STOP after step 3. No push or deployment. The branch is not yet ready for rollout.

## Step 2: authenticated connection and lifecycle integration (completed)

Each live `Room` now owns one `RoomIdentityRegistry`, using the Room monitor.
The generated participant UUID is bound through the existing internal CID-to-name
index. It is now an internal lookup ID, not a client-supplied authentication proof.
Existing rename logic preserves that binding. No second participant/game-state map
or snapshot credential persistence was introduced.

`IdentityWebSocketHandler` is the sole registered `/gameSocket` endpoint. It gates
all game commands before delegating to the existing GameWebSocketHandler. The old
handler's CID admission is disabled; `/signal/bye` returns 410 without mutating state.
Old clients must reload. There is no legacy-authentication fallback.

### Handshake and deadlines

The socket URL has no query parameters. The first JSON message has `version: 2`:

- `newJoin`: roomCode and participantName. The server reserves the name and sends
  `identityGrant` with roomInstanceId, participantId and token. The client stores
  the proof and sends `identityAck`. Only then is the participant created, activated
  and allowed to receive room state. Unacknowledged grants are revoked and their
  name reservations released at the 30-second connection deadline or disconnect.
- `resume`: roomCode, roomInstanceId, participantId and token. It can only resume an
  existing participation in the current live instance. It does not create a room,
  infer identity from a name or restore earlier host privileges.
- `identityReady`: confirms authenticated participation and canonical name.
- Unauthenticated connections have a 10-second admission deadline.
- Server `identityChallenge` messages carry a fresh nonce after each successful
  response. A matching `identityPong:<nonce>` renews the owner's 45-second lease.
  Challenges are sent at 15-second intervals; sweeps run every 5 seconds. Existing
  plain ping/pong remains for the client watchdog but does not renew ownership.
- Claims and commands also check expiry immediately. Late challenge responses,
  commands, transport closes and presence timers cannot act on a successor owner.
- `identityError` distinguishes activeElsewhere, invalid, expired, nameTaken and
  reloadRequired. An active owner is not taken over automatically.

The injectable monotonic clock and scheduler allow race/deadline tests without
sleeping. Old socket callbacks cannot deactivate a rejoined or newly named person.
Unexpected disconnection retains the existing 2-second inactive / 5-second host
transfer grace. Explicit exit uses the intentional-leave 2-second host grace.

### Atomic lifecycle and permissions

Room transactions authorize and mutate under one monitor. Outgoing writes/closes
are deferred until after the monitor is released to avoid room/socket lock inversion.
Exit and kick revoke the proof and remove identity/session mappings before freeing
the name. Room closure seals the registry and removes its mappings. New participation
uses a new UUID/proof and normal defaults. Delayed work checks the exact Room instance.
Internal client keys are length-prefixed so room codes containing separators cannot
cause another room's identity mappings to be removed.

The command-boundary review also found missing host checks for reveal/reset. These
now require the current host; self-targeted participant host-actions are rejected.
Host spectators retain host authority. No voting/statistics calculation was changed.

The client sends `intentionalLeave` and waits for `exited` before deleting its proof
and navigating away. Lost-acknowledgement/idempotent retry UX remains step 4.

### Storage and logging

`identity.js` stores proofs independently per room under `pp-identity-v2:<room>`;
localStorage is preferred, with sessionStorage and in-memory fallback. It stores
no vote, role or participation state. Matching-proof checks prevent an old tab from
deleting a newer proof on exit/kick. Proof frames bypass the room debug history.
Raw authentication payloads and parser errors are not logged, URLs contain no proof,
and framework WebSocket logging is limited to INFO by default.

The room connector skips the old name-only preflight when resuming a stored proof.
The start/invite forms and HTTP preflight still need step 3's unified live-state
name checks. Persistence-failure notices, robust retries and storage migration are
not claimed complete here. No browser/PWA restart guarantee is claimed before the
remaining integration checks and the manual iPhone test.

### Validation

- 39 focused Java tests passed: IdentityWebSocketHandlerTest (16),
  RoomIdentityRegistryTest (13), GameServiceNameTests (3), RoomTest (3),
  GameServiceSendTest (4).
- Three existing Chromium mouse/keyboard/permission participant-action tests passed.
- Two new Chromium/WebKit handshake tests passed: reload, proof isolation from
  debug history/URL, parallel-tab rejection, acknowledged exit and fresh identity.
- Existing spectator refresh/back/reconnect test passed after changing its identity
  assertion from the retired CID to the new participant UUID.
- `npm run e2e:buildcheck` passed; JavaScript syntax checks passed.

No full regression suite, production push or deployment. The test server used a
separate local port. The real iPhone/PWA check and the complete entry-path matrix
remain part of the later plan.
## Step 3 handoff: historical preparation (implemented below)

Baseline: `d42b185` on `fix/participant-identity-rejoin` (step 2), preceded by
`c1d585e` (step 1). Preparation changes documentation only. Do not push to main:
main triggers production deployment. This handoff was prepared before step 3 was authorized.

### Verified remaining blockers

- `templates/index.html`: its inline submit handler calls `name-taken` before
  submitting, even if the browser holds its own resume proof.
- `templates/invite.html` / `static/js/invite-name-check.js`: name-available is
  checked before submission; identity.js is currently loaded only on room.html.
- `GameController.getRoom`: preflight=1 rejects any existing display name before
  the browser can authenticate its proof. POST /join adds that flag.
- `RoomNameCheckController`: checks live participants by exact trimmed name.
- `rooms/web/NameAvailabilityController`: checks RoomStore snapshots using a
  lowercase comparison. It can disagree with the live check or block released names.
- `room.js`: resume already bypasses its own name preflight; new joins still use
  the old preflight/cache keys and snapshot-backed name-available endpoint.
- `IdentityWebSocketHandler`: pending initial grants reserve names in a private,
  room-scoped map until ack/disconnect/timeout. Both name APIs must account for
  these reservations without creating another independent reservation store.

### Concrete implementation order for step 3

1. Centralize the existing live-name availability/suggestion query in the server.
   Use the same Room monitor and exact trimmed, case-sensitive comparison as live
   joins. Include pending grant reservations. Move/access the existing reservations
   through one room-owned source as needed; remove the old private source rather
   than mirroring it. Reads must never create a room or reserve a name.
2. Make name-taken and name-available thin adapters over that query. Preserve their
   response shapes (boolean vs. available/suggestion), but remove snapshot reads
   and lowercase normalization. Query results remain advisory: the authenticated
   WebSocket join performs the atomic final reservation/check.
3. Load the shared identity bootstrap on index and invite, before their submit
   handlers need it. With a stored proof, submit toward room rendering without
   the name-only check; the socket must still validate the proof. Without one,
   retain regular name feedback based on the unified live query. Do not send
   proofs in URLs, hidden form fields or name-check requests.
4. Remove the identity-blind rejection from GET /room's preflight path. HTTP
   rendering is not admission or authorization; WebSocket authentication remains
   mandatory. Old preflight URLs must still render safely. Do not invent a client
   flag that claims to prove identity. Keep POST validation of required fields.
5. Consolidate room.js preflight and room-return behavior so reload/back/direct
   room navigation do not depend on stale pp-pf-ok markers. A resume uses the
   server's canonical name, even when the submitted display name differs. Do not
   silently rename, discard a valid proof or create another participation.
6. For invalid/revoked/wrong-instance proofs, give a clear result and a deliberate
   route back to New Join. Clear only the matching rejected proof. No automatic
   fallback to a new identity inside a failed resume; no takeover dialog. Check
   that invalid-return links cannot loop back into the same failed attempt.
7. Document the result, run only the focused tests below, commit separately and STOP.

### Focused validation to add/adapt

Backend (existing RoomNameCheckControllerTest plus focused availability/controller
cases): both endpoints agree for free/taken/inactive/pending names; trimmed input;
case-sensitive comparison; stale snapshots ignored; released names become free;
preflight rendering never grants access; an availability/join race has one winner.
Use controlled clocks for pending-reservation timeout; no sleeps for those checks.

Browser (Chromium and WebKit, narrow entry-point specs):

- Obtain a proof, disconnect, return through / and /invite: same participant UUID,
  spectator state and vote; no duplicate participant or unnecessary name prompt.
- Retain localStorage in a new browser context but discard sessionStorage to model
  a restarted session. Wait for confirmed disconnection rather than assuming that
  page.close immediately reached the server. This is not a real iPhone PWA test.
- Direct /room, preflight=1, refresh and Back remain valid authenticated entries.
- Wrong/revoked proof gives an error and requires deliberate New Join; matching
  display name alone never restores identity. A different browser cannot take it.
- Pending/active participation conflicts and two competing new joins are handled.
- Different rooms remain independent; stale form/availability responses must not
  override the current selected room/name or delete a newer proof.

Reuse existing `identity-handshake.spec.ts`, `spectator-rejoin.spec.ts` and relevant
`room-return.spec.ts` / duplicate-name cases as appropriate; do not run the full
suite. Keep tests on an isolated local port (8091 was used and stopped in step 2).
Run `npm run e2e:buildcheck` after TypeScript edits.

### Boundaries and resumption checklist

- Do not start step 4's lost-exit-ack retry/idempotency work, storage-failure UX or
  broad storage migration here. No gameplay, layout, snapshot restoration or new
  infrastructure changes. A storage read is only a candidate proof, never auth.
- Real iPhone/PWA verification remains later/manual. Deployment remains gated.
- At resumption: read this file, check branch/status and any commits after d42b185;
  preserve user changes. Step 2 recorded 39 passing Java tests, six passing browser
  cases and a passing TypeScript check. No tests were rerun for this preparation.
- Suggested restart instruction: "Implement step 3 from the handoff in
  docs/PARTICIPANT-IDENTITY-REJOIN.md. Run only targeted tests, document and commit
  separately, then STOP. No deployment."

## Step 3: unified entry points and live name checks (completed)

Completed on 2026-10-18. Scope: entry/admission paths only; no gameplay, layout,
permissions, protocol messages, lease durations or participant lifecycle changes.

### Changes

- Both name APIs now delegate to GameService's live availability/suggestion query,
  under the Room monitor. Comparison remains trimmed and case-sensitive. Inactive
  participants and pending initial grants reserve their names. Persisted snapshots
  are no longer a name-availability source; reads neither create rooms nor reserve
  names. Response shapes remain unchanged.
- Pending name reservations moved from the gateway's private map into the live
  Room, with conditional release by connection ID. There is only one reservation
  source. The WebSocket handshake still performs the final atomic check, so an
  advisory HTTP result cannot authorize a duplicate join.
- Home and invitation forms load the shared identity bootstrap. A candidate proof
  bypasses name-only feedback and proceeds to server-authenticated resume. Proofs
  are never submitted through form fields, URLs or name APIs.
- HTTP /room rendering no longer rejects a participant solely because their name
  exists, including legacy preflight=1 URLs. POST /join retains required-field
  validation and stops adding that flag. Rendering grants no room-state access.
- Removed room.js's name-only preflight and pp-pf-ok cache dependency. Direct entry,
  refresh and Back use the same authenticated WebSocket path. identityReady updates
  the visible name and canonical URL from the server, even with a stale form name.
- Invalid/revoked/wrong-instance proof rejection clears only the matching proof
  and the current room-return target, then renders the invitation form with an
  explanation. The user must explicitly submit to start a new participation.
  There is no automatic New Join after a failed resume or active-owner takeover.
  Name conflicts from the final handshake return to the existing name-entry flow.
- Asynchronous form checks use a generation and room/name comparison. Old responses
  cannot submit edited fields or replace current feedback.

### Targeted validation

**42 Java tests passed**:
RoomNameCheckControllerTest (5), IdentityWebSocketHandlerTest (18),
RoomIdentityRegistryTest (13), GameServiceNameTests (3), RoomTest (3).

The new/extended cases cover agreement of both APIs for active/inactive/pending/
free names, case and whitespace handling, suggestions, conditional reservation
release, no room creation on reads/rendering, legacy preflight, POST validation,
reservation timeout/disconnect, room isolation and competing new joins after a
successful advisory availability query.

**12 focused browser cases passed**:

- Six new cases across Chromium and WebKit: home/invite/direct/preflight/reload/
  Back entry; canonical name, participant UUID, vote and spectator preservation;
  new browser context retaining localStorage but no sessionStorage; invalid proof
  requiring deliberate New Join; no identity restoration by display name; room
  isolation and matching-proof clearing; stale name-check responses ignored.
- Two existing Chromium/WebKit identity-handshake cases: parallel-tab refusal,
  reload, proof exclusion from URLs/debug history, acknowledged exit/new identity.
- Existing spectator refresh/Back/reconnect case and invitation suggestion case.
- Two existing room-return cases: About/Home return and duplicate-name loop guard.

The first run of the two new state-preservation cases waited on the obsolete
away marker. The test was corrected to wait for the server's disconnected flag;
both corrected cases passed. No application change was needed for that correction.
TypeScript buildcheck, JavaScript syntax checks and diff whitespace check passed.
No full suite was run. Browser checks used the isolated local server on port 8091.
A new browser context is a restart approximation, not a real iPhone/PWA validation.

### Next boundary

Steps 5–6 retain the remaining integration matrix, manual iPhone/PWA verification,
final documentation and rollout gate. No push or deployment was performed.

## Step 4: exit recovery and browser-storage resilience (completed)

Completed on 2026-10-18. Scope: proof-bound exit recovery and identity-storage
behavior only. Gameplay, permissions, room snapshots and identity authority remain
unchanged.

### Exit completion and retry

- Before sending `intentionalLeave`, the client records a small exit marker bound
  to the current room-instance and participant UUID. It contains no token and is
  not an authorization source.
- A normal `exited` response or the existing 4400 close completes the exit, clears
  only the matching proof/marker and room-return target, then navigates home.
- If the command was processed but its acknowledgement was lost, reconnect receives
  the expected invalid-proof result. A matching pending exit treats that result as
  successful completion rather than offering a new participation.
- If the command did not reach the server, resume authenticates the existing proof;
  `identityReady` then retries the same final command. The server-side revocation
  boundary prevents duplicate lifecycle actions.
- Explicit exit now emits exactly one `participantLeft` roster event after final
  removal. This fixes stale participant rows for remaining clients while retaining
  the existing host-transfer grace and payload shape.
- Kick, room closure and unrelated invalid-proof cleanup also remove only a matching
  pending-exit marker. Active-owner rejection remains unchanged and is never treated
  as successful exit.

### Storage fallback and migration

- Identity proof writes prefer localStorage, fall back to sessionStorage and finally
  to in-memory continuity. Session-only and memory-only modes show a clear notice
  about their restoration limit while leaving the current participation usable.
- A session fallback is promoted to localStorage when durable storage becomes
  available. A successful local write removes an older session fallback, preventing
  stale proof resurrection.
- Proof and exit cleanup remain conditional on the expected identity, so an older
  page cannot delete a successor proof or marker.
- Obsolete `pp-cid` and `pp-pf-ok:*` session keys are removed during identity
  bootstrap. They are no longer read and cannot affect admission.

### Targeted validation

**41 Java tests passed**: IdentityWebSocketHandlerTest (18),
RoomIdentityRegistryTest (13), GameServiceNameTests (3), GameServiceSendTest (4)
and RoomTest (3). The exit test now also proves that remaining clients receive one
roster-removal event and that the revoked proof cannot restore state.

**16 focused browser cases passed** across the final run plus the corrected exact-row
rerun: Chromium/WebKit lost-ack completion, retry when the original command was not
processed, fresh identity after exit, existing handshake/parallel-tab behavior,
memory-only notice/current usability, browser-storage migration and stale fallback
protection, host/guest/keyboard exit behavior, and responsive exit controls.

One existing exit test initially failed because it still expected an explicitly
removed participant to remain as disconnected; that assertion was updated to the
approved final-exit lifecycle. A later selector matched the new host-role label
instead of the departed participant's name; exact name selection passed. Neither
test correction required broader product behavior.

TypeScript buildcheck, JavaScript syntax checks and diff whitespace checks passed.
No full suite or real iPhone/PWA validation was run. The isolated browser-test server
used port 8091 and was stopped afterward.

### Next boundary

Step 5 remains separately gated: complete the focused integration matrix and manual
iPhone/PWA verification. Step 6 covers final architecture/API/user/deployment docs
and the controlled rollout gate. No push or deployment was performed. STOP after
this separate step-4 commit.

## Step 5: integration validation and physical-device gate (automated part completed)

Completed on 2026-10-18. This step changed no production code, protocol, gameplay,
permissions, identity lifecycle or UI. It validated the integrated behavior from
the server identity source through browser storage, entry points and room actions.

### Automated validation

**46 focused Java tests passed**: IdentityWebSocketHandlerTest (18),
RoomIdentityRegistryTest (13), RoomNameCheckControllerTest (5),
GameServiceNameTests (3), GameServiceSendTest (4) and RoomTest (3).

Together these deterministically cover pending-grant and lease expiry, concurrent
claims and rejoins, stale owners/messages/disconnects, heartbeat authorization,
room isolation, invalid and revoked proofs, explicit exit, kick, host transfer,
host-right non-reclamation, room closure and room-code reuse. Controlled clocks are
used for timeout boundaries; the tests do not depend on sleeps for those checks.

**41 focused browser cases passed** against the isolated local E2E server:

- 39 identity, entry, reconnect, exit, storage and navigation cases, including the
  explicit Chromium/WebKit identity-entry, handshake and lost-exit-ack scenarios;
- refresh, Back navigation, simulated browser restart, temporary reconnect,
  heartbeat, parallel-tab refusal, room isolation and canonical state restoration;
- spectator and vote preservation, deliberate new join after invalid proof,
  duplicate-name handling, stale form-response fencing and storage degradation;
- two participant-action cases covering the spectator round trip, host transfer,
  kick, guest/spectator restrictions and forged self-target rejection.

The shared menu-event check, E2E TypeScript buildcheck and identity.js/room.js
syntax checks also passed. No full test suite was run.

### Required physical iPhone/PWA check

The browser restart test uses a fresh browser context with retained localStorage;
it is intentionally an approximation, not evidence for iOS process eviction or an
installed PWA. The real-device check therefore remains a rollout gate and must be
run on the deployment candidate before the identity change is declared complete:

1. Join a uniquely named room from the installed PWA, vote, become a spectator and
   return to participating; after each state, fully close and reopen the PWA and
   confirm one participant row, the same state and no name prompt.
2. Suspend the PWA beyond the reconnect window, reopen it and confirm that the
   existing participation resumes without a duplicate or reset.
3. Open the same participation concurrently in Safari and confirm that the active
   owner remains authoritative and the second connection cannot take it over.
4. Transfer the host role, restart the former host's PWA and confirm that it does
   not reclaim host rights. Repeat with spectator state and a retained vote.
5. Explicitly leave, then rejoin with the same name and confirm a fresh default
   participation. Kick a participant and confirm its old proof cannot resume.
6. Close and recreate a room with the same code and confirm that the prior room's
   proof is rejected and cannot restore state in the new room instance.

Record device/iOS version and results with the rollout evidence. A failed item
blocks rollout and returns to the smallest responsible step; it does not authorize
a workaround based on participant name or client-only state.

### Next boundary

Step 6 remains separately gated: finish architecture/API/user/deployment
documentation and prepare the controlled rollout. Do not deploy until the user
explicitly approves it. The real iPhone/PWA result must be recorded before final
completion. STOP after the separate step-5 validation commit.
