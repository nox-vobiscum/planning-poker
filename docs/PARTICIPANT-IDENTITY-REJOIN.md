# Participant identity and rejoin implementation

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

## Remaining approved plan after step 2 (requires separate authorization)

3. Unify entry points and live-state name checks.
4. Complete exit acknowledgements, retries and storage-failure behavior.
5. Run focused backend and Chromium/WebKit integration checks; manual iPhone PWA check.
6. Update final architecture/API/user/deployment docs and prepare a controlled rollout.

STOP after step 2. No push or deployment. The branch is not yet ready for rollout.

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