package com.example.planningpoker.handler;

import com.example.planningpoker.service.GameService;
import com.example.planningpoker.controller.SignalController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.*;
import tools.jackson.databind.json.JsonMapper;
import java.net.URI;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class IdentityWebSocketHandlerTest {
    private final AtomicLong now = new AtomicLong();
    private final List<Runnable> scheduled = new CopyOnWriteArrayList<>();
    private final ScheduledExecutorService scheduler = testScheduler();
    private final GameService service = new GameService(now::get, scheduler);
    private ScheduledExecutorService testScheduler() {
        ScheduledExecutorService timer = mock(ScheduledExecutorService.class);
        when(timer.schedule(any(Runnable.class), anyLong(), any(TimeUnit.class))).thenAnswer(call -> {
            scheduled.add(call.getArgument(0));
            return mock(ScheduledFuture.class);
        });
        return timer;
    }
    private final GameWebSocketHandler commands = new GameWebSocketHandler(service);
    private final IdentityWebSocketHandler gateway = new IdentityWebSocketHandler(service, commands, now::get, false);
    private final JsonMapper json = new JsonMapper();
    private final AtomicInteger ids = new AtomicInteger();
    @AfterEach void stop() { gateway.shutdown(); }

    private final class Client {
        final WebSocketSession socket = mock(WebSocketSession.class);
        final List<String> frames = new CopyOnWriteArrayList<>();
        final AtomicBoolean open = new AtomicBoolean(true);
        Client(String query) throws Exception {
            when(socket.getId()).thenReturn("socket-" + ids.incrementAndGet());
            when(socket.getUri()).thenReturn(URI.create("ws://localhost/gameSocket" + query));
            when(socket.isOpen()).thenAnswer(i -> open.get());
            doAnswer(i -> { frames.add(((TextMessage) i.getArgument(0)).getPayload()); return null; })
                    .when(socket).sendMessage(any());
            doAnswer(i -> { open.set(false); gateway.afterConnectionClosed(socket, i.getArgument(0)); return null; })
                    .when(socket).close(any(CloseStatus.class));
            gateway.afterConnectionEstablished(socket);
        }
        void send(String text) { gateway.handleTextMessage(socket, new TextMessage(text)); }
        void send(Map<String, ?> value) { send(json.writeValueAsString(value)); }
        Map<String, Object> last(String type) {
            for (int i = frames.size() - 1; i >= 0; i--) {
                try {
                    Map<String, Object> value = json.readValue(frames.get(i), Map.class);
                    if (type.equals(value.get("type"))) return value;
                } catch (Exception ignored) {}
            }
            return Map.of();
        }
        long count(String type) {
            return frames.stream().filter(frame -> {
                try { return type.equals(json.readValue(frame, Map.class).get("type")); }
                catch (Exception ignored) { return false; }
            }).count();
        }
        void disconnect() { open.set(false); gateway.afterConnectionClosed(socket, CloseStatus.NORMAL); }
    }

    private Client client() throws Exception { return new Client(""); }
    private Map<String, Object> begin(Client c, String name) {
        c.send(Map.of("version", 2, "type", "newJoin", "roomCode", "room", "participantName", name));
        Map<String, Object> grant = c.last("identityGrant");
        assertFalse(grant.isEmpty());
        return grant;
    }
    private Map<String, Object> join(Client c, String name) {
        Map<String, Object> grant = begin(c, name);
        c.send("identityAck");
        assertEquals(name, c.last("identityReady").get("yourName"));
        return grant;
    }
    private void resume(Client c, Map<String, Object> grant) {
        Map<String, Object> request = new HashMap<>(grant);
        request.put("type", "resume"); request.put("version", 2); request.put("roomCode", "room");
        c.send(request);
    }
    private void advance(int seconds) { now.addAndGet(Duration.ofSeconds(seconds).toNanos()); }
    private void heartbeat(Client c) { c.send("identityPong:" + c.last("identityChallenge").get("nonce")); }

    @Test void legacyAndUnauthenticatedCommandsNeverJoinOrReceiveRoomState() throws Exception {
        Client legacy = new Client("?roomCode=room&participantName=Host&cid=known");
        assertFalse(legacy.open.get());
        assertTrue(legacy.frames.isEmpty());
        Client raw = client(); raw.send("revealCards");
        assertFalse(raw.open.get());
        assertNull(service.getRoom("room"));
        assertEquals(410, new SignalController(service).bye("room", "known").getStatusCode().value());
    }

    @Test void initialGrantRequiresAcknowledgementAndAbandonedReservationExpires() throws Exception {
        Client pending = client(); Map<String, Object> lost = begin(pending, "Host");
        assertFalse(service.nameAvailability("room", "Host").available());
        assertNull(service.getRoom("room").getParticipant("Host"));
        assertTrue(pending.last("roomState").isEmpty());
        Client collision = client();
        collision.send(Map.of("version", 2, "type", "newJoin", "roomCode", "room", "participantName", "Host"));
        assertEquals("nameTaken", collision.last("identityError").get("reason"));
        advance(30); gateway.sweep();
        assertFalse(pending.open.get());
        assertTrue(service.nameAvailability("room", "Host").available());
        Client fresh = client(); join(fresh, "Host");
        Client stale = client(); resume(stale, lost);
        assertEquals("invalid", stale.last("identityError").get("reason"));
    }

    @Test void advisoryAvailabilityDoesNotPermitTwoConcurrentNewJoins() throws Exception {
        Client a = client(), b = client();
        assertTrue(service.nameAvailability("room", "Same").available());
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<?>> attempts = new ArrayList<>();
            for (Client c : List.of(a, b)) {
                attempts.add(pool.submit(() -> {
                    try { start.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
                    c.send(Map.of("version", 2, "type", "newJoin", "roomCode", "room", "participantName", "Same"));
                }));
            }
            start.countDown();
            for (Future<?> attempt : attempts) attempt.get(5, TimeUnit.SECONDS);
            Client winner = a.last("identityGrant").isEmpty() ? b : a;
            Client loser = winner == a ? b : a;
            assertEquals("nameTaken", loser.last("identityError").get("reason"));
            assertTrue(loser.last("identityGrant").isEmpty());
            winner.send("identityAck");
            assertEquals(1, service.getRoom("room").getParticipants().size());
            assertEquals("Same", winner.last("identityReady").get("yourName"));
            assertFalse(service.nameAvailability("room", "Same").available());
        } finally { pool.shutdownNow(); }
    }

    @Test void pendingDisconnectReleasesOnlyItsOwnRoomReservation() throws Exception {
        Client pending = client(); begin(pending, "Same");
        var other = service.getOrCreateRoom("other");
        assertTrue(other.reserveName("Same", "other-socket"));
        pending.disconnect();
        assertTrue(service.nameAvailability("room", "Same").available());
        assertFalse(service.nameAvailability("other", "Same").available());
    }
    @Test void handshakeDeadlineIsEnforcedWithoutADisconnectEvent() throws Exception {
        Client c = client(); advance(10); gateway.sweep();
        assertFalse(c.open.get());
        assertNull(service.getRoom("room"));
    }

    @Test void resumePreservesVoteSpectatorAndRenamedIdentity() throws Exception {
        Client first = client(); Map<String, Object> grant = join(first, "Host");
        first.send("vote:ignored:5");
        first.send("participation:false");
        first.send("rename:Renamed");
        String vote = service.getRoom("room").getParticipant("Renamed").getVote();
        first.disconnect();
        Client second = client(); resume(second, grant);
        assertEquals("Renamed", second.last("identityReady").get("yourName"));
        var p = service.getRoom("room").getParticipant("Renamed");
        assertTrue(p.isSpectator());
        assertEquals(vote, p.getVote());
        assertEquals(1, service.getRoom("room").getParticipants().size());
        first.send("participation:true");
        gateway.afterConnectionClosed(first.socket, CloseStatus.NORMAL);
        assertTrue(p.isSpectator());
        assertTrue(p.isActive());
    }

    @Test void activeOwnerRejectsParallelTabWithoutDisclosingState() throws Exception {
        Client owner = client(); Map<String, Object> grant = join(owner, "Host");
        Client second = client(); resume(second, grant);
        assertEquals("activeElsewhere", second.last("identityError").get("reason"));
        assertTrue(second.last("identityReady").isEmpty());
        second.send("vote:Host:40");
        assertNull(service.getRoom("room").getParticipant("Host").getVote());
        owner.send("vote:Host:3");
        assertEquals("3", service.getRoom("room").getParticipant("Host").getVote());
    }

    @Test void staleSocketIsFencedAndLatePongOrCloseCannotDamageNewOwner() throws Exception {
        Client old = client(); Map<String, Object> grant = join(old, "Host");
        advance(45); // socket still reports open; no transport close event.
        Client resumed = client(); resume(resumed, grant);
        assertFalse(resumed.last("identityReady").isEmpty());
        assertFalse(old.open.get());
        old.send("vote:Host:40"); heartbeat(old);
        gateway.afterConnectionClosed(old.socket, CloseStatus.NORMAL);
        resumed.send("vote:Host:5");
        assertEquals("5", service.getRoom("room").getParticipant("Host").getVote());
        assertTrue(service.getRoom("room").getParticipant("Host").isActive());
    }

    @Test void onlyMatchingChallengeResponseRenewsLease() throws Exception {
        Client c = client(); Map<String, Object> grant = join(c, "Host");
        advance(30); heartbeat(c);
        advance(15); gateway.sweep();
        assertTrue(c.open.get());
        c.send("identityPong:wrong");
        c.send("ping"); // Legacy client pings do not renew the identity lease.
        advance(30); gateway.sweep();
        assertFalse(c.open.get());
        Client resumed = client(); resume(resumed, grant);
        assertFalse(resumed.last("identityReady").isEmpty());
    }

    @Test void concurrentRejoinsProduceOneOwner() throws Exception {
        Client old = client(); Map<String, Object> grant = join(old, "Host"); old.disconnect();
        Client a = client(); Client b = client();
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var fa = pool.submit(() -> { assertTrue(start.await(5, TimeUnit.SECONDS)); resume(a, grant); return true; });
            var fb = pool.submit(() -> { assertTrue(start.await(5, TimeUnit.SECONDS)); resume(b, grant); return true; });
            start.countDown(); fa.get(5, TimeUnit.SECONDS); fb.get(5, TimeUnit.SECONDS);
        }
        assertEquals(1, (a.last("identityReady").isEmpty() ? 0 : 1) + (b.last("identityReady").isEmpty() ? 0 : 1));
        assertEquals(1, service.getRoom("room").getParticipants().size());
    }

    @Test void exitReleasesNameButNeverRestoresOldProofOrState() throws Exception {
        Client old = client(); Map<String, Object> grant = join(old, "Host");
        Client observer = client(); join(observer, "Observer");
        old.send("vote:Host:8"); old.send("participation:false"); old.send("intentionalLeave");
        assertFalse(old.last("exited").isEmpty());
        assertEquals(1, observer.count("participantLeft"));
        assertNull(service.getRoom("room").getParticipant("Host"));
        assertNull(service.getClientName("room", (String) grant.get("participantId")));
        Client fresh = client(); Map<String, Object> replacement = join(fresh, "Host");
        assertNotEquals(grant.get("participantId"), replacement.get("participantId"));
        assertNull(service.getRoom("room").getParticipant("Host").getVote());
        assertFalse(service.getRoom("room").getParticipant("Host").isSpectator());
        old.send("vote:Host:40");
        Client stale = client(); resume(stale, grant);
        assertEquals("invalid", stale.last("identityError").get("reason"));
        assertNull(service.getRoom("room").getParticipant("Host").getVote());
    }

    @Test void kickRevokesProofAndGuestsCannotRunHostCommands() throws Exception {
        Client host = client(); join(host, "Host");
        Client guest = client(); Map<String, Object> proof = join(guest, "Guest");
        guest.send("revealCards"); guest.send("resetRoom"); guest.send("kick:Host");
        assertFalse(service.getRoom("room").areVotesRevealed());
        assertNotNull(service.getRoom("room").getParticipant("Host"));
        host.send("kick:Guest");
        assertNull(service.getRoom("room").getParticipant("Guest"));
        guest.send("vote:Guest:40");
        Client rejected = client(); resume(rejected, proof);
        assertEquals("invalid", rejected.last("identityError").get("reason"));
        Client fresh = client(); join(fresh, "Guest");
        assertNull(service.getRoom("room").getParticipant("Guest").getVote());
    }

    @Test void transferredHostRightsAreNotReclaimedOnResume() throws Exception {
        Client oldHost = client(); Map<String, Object> proof = join(oldHost, "Host");
        Client next = client(); join(next, "Next");
        oldHost.send("makeHost:Next"); oldHost.disconnect();
        Client resumed = client(); resume(resumed, proof);
        resumed.send("revealCards");
        assertEquals("Next", service.getRoom("room").getHost().getName());
        assertFalse(service.getRoom("room").areVotesRevealed());
    }

    @Test void closeAndRecreatedRoomRejectPriorInstanceCredentials() throws Exception {
        Client host = client(); Map<String, Object> proof = join(host, "Host");
        host.send("closeRoom"); assertNull(service.getRoom("room"));
        Client fresh = client(); Map<String, Object> newProof = join(fresh, "Host");
        assertNotEquals(proof.get("roomInstanceId"), newProof.get("roomInstanceId"));
        Client stale = client(); resume(stale, proof);
        assertEquals("invalid", stale.last("identityError").get("reason"));
        host.send("closeRoom");
        assertNotNull(service.getRoom("room"));
    }
    @Test void oldPresenceTimersCannotDeactivateRejoinedOrReplacedParticipation() throws Exception {
        Client host = client(); Map<String, Object> proof = join(host, "Host");
        Client guest = client(); join(guest, "Guest");
        host.disconnect();
        List<Runnable> oldTimers = List.copyOf(scheduled); scheduled.clear();
        Client resumed = client(); resume(resumed, proof);
        oldTimers.forEach(Runnable::run);
        assertTrue(service.getRoom("room").getParticipant("Host").isActive());
        assertEquals("Host", service.getRoom("room").getHost().getName());
        resumed.send("intentionalLeave");
        Client newPerson = client(); join(newPerson, "Host");
        oldTimers.forEach(Runnable::run);
        assertTrue(service.getRoom("room").getParticipant("Host").isActive());
    }

    @Test void actualDisconnectTransfersHostAndResumeDoesNotUndoIt() throws Exception {
        Client host = client(); Map<String, Object> proof = join(host, "Host");
        Client guest = client(); join(guest, "Guest");
        host.disconnect();
        List.copyOf(scheduled).forEach(Runnable::run);
        assertEquals("Guest", service.getRoom("room").getHost().getName());
        Client resumed = client(); resume(resumed, proof);
        resumed.send("revealCards");
        assertEquals("Guest", service.getRoom("room").getHost().getName());
        assertFalse(service.getRoom("room").areVotesRevealed());
    }

    @Test void gameAndSnapshotWritesLeaveTheRoomMonitorBeforeSocketIo() throws Exception {
        Client host = client(); join(host, "Host");
        var room = service.getRoom("room");
        doAnswer(call -> {
            assertFalse(Thread.holdsLock(room), "Network write while holding Room monitor");
            return null;
        }).when(host.socket).sendMessage(any());
        host.send("vote:Host:5");
        host.send("requestSync");
        host.send("intentionalLeave");
    }

    @Test void roomKeyCleanupCannotInvalidateAnotherRoomWithPrefixCode() throws Exception {
        Client a = client(); Map<String, Object> proof = join(a, "Host");
        Client b = client();
        b.send(Map.of("version", 2, "type", "newJoin", "roomCode", "room|other", "participantName", "Host"));
        Map<String, Object> other = b.last("identityGrant"); b.send("identityAck");
        a.send("closeRoom");
        assertEquals("Host", service.getClientName("room|other", (String) other.get("participantId")));
        b.send("vote:Host:8");
        assertEquals("8", service.getRoom("room|other").getParticipant("Host").getVote());
    }
}
