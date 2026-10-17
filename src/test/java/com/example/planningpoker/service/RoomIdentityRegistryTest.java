package com.example.planningpoker.service;

import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import static com.example.planningpoker.service.RoomIdentityRegistry.*;
import static org.junit.jupiter.api.Assertions.*;

class RoomIdentityRegistryTest {
    private final Object monitor = new Object();
    private final AtomicLong time = new AtomicLong();
    private final RoomIdentityRegistry registry = new RoomIdentityRegistry(monitor, time::get, DEFAULT_LEASE);
    private void advance(long seconds) { time.addAndGet(Duration.ofSeconds(seconds).toNanos()); }

    @Test void issuesIndependentRoomBoundCredentialsWithoutLoggingSecrets() {
        Credential first = registry.issue();
        Credential second = registry.issue();
        RoomIdentityRegistry otherRoom = new RoomIdentityRegistry(new Object());
        assertEquals(32, Base64.getUrlDecoder().decode(first.token()).length);
        assertNotEquals(first.token(), second.token());
        assertNotEquals(first.participantId(), second.participantId());
        assertEquals(registry.roomInstanceId(), first.roomInstanceId());
        assertTrue(registry.validates(first));
        assertTrue(registry.validates(second));
        assertFalse(otherRoom.validates(first));
        assertFalse(first.toString().contains(first.token()));
    }

    @Test void rejectsWrongParticipantRoomTokenAndMalformedCredentials() {
        Credential first = registry.issue();
        Credential second = registry.issue();
        String modified = (first.token().charAt(0) == 'A' ? "B" : "A") + first.token().substring(1);
        Credential[] invalid = {
            null,
            new Credential(UUID.randomUUID(), first.participantId(), first.token()),
            new Credential(first.roomInstanceId(), second.participantId(), first.token()),
            new Credential(first.roomInstanceId(), UUID.randomUUID(), first.token()),
            new Credential(first.roomInstanceId(), first.participantId(), modified),
            new Credential(first.roomInstanceId(), first.participantId(), null),
            new Credential(first.roomInstanceId(), first.participantId(), ""),
            new Credential(null, null, first.token())
        };
        for (Credential candidate : invalid) {
            assertFalse(registry.validates(candidate));
            Claim claim = registry.claim(candidate, "socket");
            assertEquals(ClaimStatus.INVALID, claim.status());
            assertNull(claim.owner());
        }
        assertTrue(registry.validates(first));
    }

    @Test void activeConnectionCannotBeTakenOverEvenWithSameConnectionId() {
        Credential credential = registry.issue();
        Claim first = registry.claim(credential, "one");
        assertEquals(ClaimStatus.ACQUIRED, first.status());
        assertEquals(ClaimStatus.ACTIVE, registry.claim(credential, "two").status());
        assertEquals(ClaimStatus.ACTIVE, registry.claim(credential, "one").status());
        assertTrue(registry.renew(first.owner()));
    }

    @Test void disconnectPreservesIdentityButFencesOldCallbacksAndMessages() {
        Credential credential = registry.issue();
        Ownership old = registry.claim(credential, "socket").owner();
        assertTrue(registry.release(old));
        assertTrue(registry.validates(credential));
        // Even reuse of the same socket identifier cannot reuse a generation.
        Ownership next = registry.claim(credential, "socket").owner();
        assertEquals(old.participantId(), next.participantId());
        assertTrue(next.generation() > old.generation());
        assertFalse(registry.release(old));
        assertFalse(registry.renew(old));
        assertFalse(registry.runIfOwner(old, () -> fail("Stale command executed")));
        assertTrue(registry.runIfOwner(next, () -> assertTrue(Thread.holdsLock(monitor))));
    }

    @Test void leaseExpiresAtExactBoundaryAndLateHeartbeatCannotReviveIt() {
        Credential credential = registry.issue();
        Ownership old = registry.claim(credential, "old").owner();
        advance(44);
        assertTrue(registry.runIfOwner(old, () -> {}));
        assertEquals(ClaimStatus.ACTIVE, registry.claim(credential, "new").status());
        advance(1);
        assertFalse(registry.renew(old));
        assertFalse(registry.runIfOwner(old, () -> fail("Expired owner executed")));
        Claim next = registry.claim(credential, "new");
        assertEquals(ClaimStatus.ACQUIRED, next.status());
        assertEquals(old, next.displaced());
        assertFalse(registry.release(old));
        assertTrue(registry.renew(next.owner()));
    }

    @Test void heartbeatExtendsLeaseAndSweepOnlyFencesExpiredConnections() {
        Credential a = registry.issue();
        Credential b = registry.issue();
        Ownership ownerA = registry.claim(a, "a").owner();
        Ownership ownerB = registry.claim(b, "b").owner();
        advance(30);
        assertTrue(registry.renew(ownerA));
        advance(15);
        assertEquals(List.of(ownerB), registry.expireConnections());
        assertTrue(registry.expireConnections().isEmpty());
        assertTrue(registry.validates(b));
        assertFalse(registry.renew(ownerB));
        assertTrue(registry.runIfOwner(ownerA, () -> {}));
        advance(30);
        assertEquals(List.of(ownerA), registry.expireConnections());
        assertEquals(ClaimStatus.ACQUIRED, registry.claim(b, "replacement").status());
    }

    @Test void revokeIsFinalAndDoesNotAffectOtherParticipants() {
        Credential a = registry.issue();
        Credential b = registry.issue();
        Ownership old = registry.claim(a, "a").owner();
        assertEquals(old, registry.revoke(a.participantId()));
        assertNull(registry.revoke(a.participantId()));
        assertFalse(registry.validates(a));
        assertEquals(ClaimStatus.INVALID, registry.claim(a, "late").status());
        assertFalse(registry.renew(old));
        assertFalse(registry.release(old));
        assertFalse(registry.runIfOwner(old, () -> fail("Revoked command executed")));
        assertTrue(registry.validates(b));
        Credential fresh = registry.issue();
        assertNotEquals(a.participantId(), fresh.participantId());
        assertNotEquals(a.token(), fresh.token());
    }

    @Test void roomCloseInvalidatesAllAndCannotBeReopened() {
        Credential a = registry.issue();
        Credential b = registry.issue();
        Ownership owner = registry.claim(a, "a").owner();
        assertEquals(List.of(owner), registry.close());
        assertTrue(registry.close().isEmpty());
        assertFalse(registry.validates(a));
        assertFalse(registry.validates(b));
        assertFalse(registry.renew(owner));
        assertFalse(registry.runIfOwner(owner, () -> fail("Closed room command")));
        assertEquals(ClaimStatus.INVALID, registry.claim(a, "late").status());
        assertThrows(IllegalStateException.class, registry::issue);
        RoomIdentityRegistry recreated = new RoomIdentityRegistry(monitor);
        assertNotEquals(registry.roomInstanceId(), recreated.roomInstanceId());
        assertFalse(recreated.validates(a));
    }

    @Test void simultaneousClaimsHaveExactlyOneWinner() throws Exception {
        Credential credential = registry.issue();
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> {
                ready.countDown();
                assertTrue(start.await(5, TimeUnit.SECONDS));
                return registry.claim(credential, "one");
            });
            var second = executor.submit(() -> {
                ready.countDown();
                assertTrue(start.await(5, TimeUnit.SECONDS));
                return registry.claim(credential, "two");
            });
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            List<Claim> results = List.of(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
            assertEquals(1, results.stream().filter(c -> c.status() == ClaimStatus.ACQUIRED).count());
            assertEquals(1, results.stream().filter(c -> c.status() == ClaimStatus.ACTIVE).count());
        }
    }

    @Test void commandAndRevocationShareTheRoomTransactionLock() {
        Credential credential = registry.issue();
        Ownership owner = registry.claim(credential, "one").owner();
        AtomicInteger mutations = new AtomicInteger();
        assertTrue(registry.runIfOwner(owner, () -> {
            assertTrue(Thread.holdsLock(monitor));
            mutations.incrementAndGet();
        }));
        synchronized (monitor) {
            registry.revoke(credential.participantId());
            // A name can now be freed within this same transaction.
            assertFalse(registry.runIfOwner(owner, mutations::incrementAndGet));
        }
        assertEquals(1, mutations.get());
    }

    @Test void rejectsForgedOwnershipHandles() {
        Credential credential = registry.issue();
        Ownership owner = registry.claim(credential, "real").owner();
        Ownership[] invalid = {
            null,
            new Ownership(UUID.randomUUID(), owner.participantId(), owner.generation(), "real"),
            new Ownership(owner.roomInstanceId(), UUID.randomUUID(), owner.generation(), "real"),
            new Ownership(owner.roomInstanceId(), owner.participantId(), owner.generation() + 1, "real"),
            new Ownership(owner.roomInstanceId(), owner.participantId(), owner.generation(), "other")
        };
        for (Ownership candidate : invalid) {
            assertFalse(registry.renew(candidate));
            assertFalse(registry.release(candidate));
            assertFalse(registry.runIfOwner(candidate, () -> fail("Invalid handle executed")));
        }
        assertTrue(registry.renew(owner));
    }

    @Test void monotonicElapsedTimeHandlesNanoTimeWraparound() {
        time.set(Long.MAX_VALUE - Duration.ofSeconds(10).toNanos());
        Credential credential = registry.issue();
        Ownership owner = registry.claim(credential, "one").owner();
        advance(44);
        assertTrue(registry.runIfOwner(owner, () -> {}));
        advance(1);
        assertFalse(registry.renew(owner));
    }

    @Test void invalidLeaseAndConnectionInputsFailWithoutIssuingOwnership() {
        assertThrows(IllegalArgumentException.class, () ->
                new RoomIdentityRegistry(monitor, time::get, Duration.ZERO));
        Credential credential = registry.issue();
        assertThrows(IllegalArgumentException.class, () -> registry.claim(credential, " "));
        assertThrows(IllegalArgumentException.class, () -> registry.claim(credential, null));
        assertEquals(ClaimStatus.ACQUIRED, registry.claim(credential, "valid").status());
    }
}
