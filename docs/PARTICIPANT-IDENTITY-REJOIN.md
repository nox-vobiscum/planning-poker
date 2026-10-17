# Participant identity and rejoin implementation

## Step 1: isolated identity core (completed)

Branch: `fix/participant-identity-rejoin`.

`RoomIdentityRegistry` is an unconnected, in-memory component for one live room
instance. It is not a Spring bean and has no application callers. Existing CID,
HTTP/WebSocket, browser storage, participant lifecycle and gameplay behavior are
unchanged. This step does not fix the reported PWA/form rejoin bug by itself.

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

## Required integration contract (not implemented)

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

## Remaining approved plan (requires the next step's authorization)

2. Atomically integrate authenticated join, connection ownership and final lifecycle.
3. Unify entry points and live-state name checks.
4. Complete exit acknowledgements, retries and storage-failure behavior.
5. Run focused backend and Chromium/WebKit integration checks; manual iPhone PWA check.
6. Update final architecture/API/user/deployment docs and prepare a controlled rollout.

STOP after step 1. No production push or deployment.
