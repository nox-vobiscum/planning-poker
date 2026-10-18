package com.example.planningpoker.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.*;
import java.util.function.LongSupplier;

/**
 * Identity/ownership for ONE live room. Not wired into the application yet.
 * Integration must create one registry per Room using that Room as monitor.
 * No names, roles, votes or participation state are stored here. Never persist it.
 */
public final class RoomIdentityRegistry {
    public static final Duration DEFAULT_LEASE = Duration.ofSeconds(45);
    private static final SecureRandom RANDOM = new SecureRandom();
    private final UUID roomInstanceId = UUID.randomUUID();
    private final Object monitor;
    private final LongSupplier nanoTime;
    private final long leaseNanos;
    private final Map<UUID, Entry> entries = new HashMap<>();
    private boolean closed;

    public RoomIdentityRegistry(Object roomMonitor) {
        this(roomMonitor, System::nanoTime, DEFAULT_LEASE);
    }

    /** Deterministic clock seam; elapsed time must be monotonic. */
    public RoomIdentityRegistry(Object roomMonitor, LongSupplier nanoTime, Duration lease) {
        this.monitor = Objects.requireNonNull(roomMonitor);
        this.nanoTime = Objects.requireNonNull(nanoTime);
        this.leaseNanos = Objects.requireNonNull(lease).toNanos();
        if (leaseNanos <= 0) throw new IllegalArgumentException("Lease must be positive");
    }

    public UUID roomInstanceId() { return roomInstanceId; }

    /** Issue once for a NEW participation, within the room's join transaction. */
    public Credential issue() {
        synchronized (monitor) {
            if (closed) throw new IllegalStateException("Room identity registry is closed");
            UUID participantId;
            do { participantId = UUID.randomUUID(); } while (entries.containsKey(participantId));
            byte[] random = new byte[32];
            RANDOM.nextBytes(random);
            String token = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
            entries.put(participantId, new Entry(hash(token)));
            return new Credential(roomInstanceId, participantId, token);
        }
    }

    /** Authenticity only; a valid credential can still have an active owner. */
    public boolean validates(Credential credential) {
        synchronized (monitor) { return authenticated(credential) != null; }
    }

    /** Atomic claim; never replaces an owner whose lease is still valid. */
    public Claim claim(Credential credential, String connectionId) {
        if (connectionId == null || connectionId.isBlank())
            throw new IllegalArgumentException("Connection ID required");
        synchronized (monitor) {
            Entry entry = authenticated(credential);
            if (entry == null) return new Claim(ClaimStatus.INVALID, null, null);
            long now = nanoTime.getAsLong();
            if (entry.owner != null && !expired(entry, now))
                return new Claim(ClaimStatus.ACTIVE, null, null);
            Ownership displaced = entry.owner;
            Ownership owner = new Ownership(roomInstanceId, credential.participantId(),
                    ++entry.generation, connectionId);
            entry.owner = owner;
            entry.lastSeenNanos = now;
            return new Claim(ClaimStatus.ACQUIRED, owner, displaced);
        }
    }

    /** Only call after a valid heartbeat from the authenticated socket. */
    public boolean renew(Ownership owner) {
        synchronized (monitor) {
            Entry entry = current(owner);
            if (entry == null) return false;
            entry.lastSeenNanos = nanoTime.getAsLong();
            return true;
        }
    }

    /**
     * Authorize AND mutate under the room monitor, not via a separate boolean check.
     * The callback must be synchronous. Perform socket I/O outside this monitor.
     */
    public boolean runIfOwner(Ownership owner, Runnable action) {
        Objects.requireNonNull(action);
        synchronized (monitor) {
            if (current(owner) == null) return false;
            action.run();
            return true;
        }
    }

    /** Disconnect releases ownership, not identity. Old callbacks cannot release a successor. */
    public boolean release(Ownership owner) {
        synchronized (monitor) {
            Entry entry = matching(owner);
            if (entry == null) return false;
            entry.owner = null;
            return true;
        }
    }

    /** Fence first; close the returned sockets outside the monitor. */
    public List<Ownership> expireConnections() {
        synchronized (monitor) {
            long now = nanoTime.getAsLong();
            List<Ownership> expired = new ArrayList<>();
            for (Entry entry : entries.values()) {
                if (entry.owner != null && expired(entry, now)) {
                    expired.add(entry.owner);
                    entry.owner = null;
                }
            }
            return List.copyOf(expired);
        }
    }

    /** Exit/kick: call under the room monitor BEFORE freeing the name. */
    public Ownership revoke(UUID participantId) {
        synchronized (monitor) {
            Entry removed = entries.remove(participantId);
            return removed == null ? null : removed.owner;
        }
    }

    /** Permanently seal this room instance and invalidate all credentials/owners. */
    public List<Ownership> close() {
        synchronized (monitor) {
            closed = true;
            List<Ownership> owners = entries.values().stream()
                    .map(entry -> entry.owner).filter(Objects::nonNull).toList();
            entries.clear();
            return owners;
        }
    }

    /** Guard delayed presence work against any intervening reconnect/revocation. */
    public boolean isDisconnected(Ownership owner) {
        synchronized (monitor) {
            if (closed || owner == null || !roomInstanceId.equals(owner.roomInstanceId())) return false;
            Entry entry = entries.get(owner.participantId());
            return entry != null && entry.generation == owner.generation() && entry.owner == null;
        }
    }

    private Entry authenticated(Credential credential) {
        if (closed || credential == null || !roomInstanceId.equals(credential.roomInstanceId())
                || credential.token() == null || credential.token().length() != 43) return null;
        Entry entry = entries.get(credential.participantId());
        return entry != null && MessageDigest.isEqual(entry.tokenHash, hash(credential.token()))
                ? entry : null;
    }

    private Entry matching(Ownership owner) {
        if (closed || owner == null || !roomInstanceId.equals(owner.roomInstanceId())) return null;
        Entry entry = entries.get(owner.participantId());
        return entry != null && owner.equals(entry.owner) ? entry : null;
    }

    private Entry current(Ownership owner) {
        Entry entry = matching(owner);
        return entry != null && !expired(entry, nanoTime.getAsLong()) ? entry : null;
    }

    private boolean expired(Entry entry, long now) {
        return now - entry.lastSeenNanos >= leaseNanos;
    }

    private static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static final class Entry {
        private final byte[] tokenHash;
        private long generation;
        private long lastSeenNanos;
        private Ownership owner;
        private Entry(byte[] tokenHash) { this.tokenHash = tokenHash; }
    }

    /** Secret-bearing handoff only; never pass to generic payload logging. */
    public record Credential(UUID roomInstanceId, UUID participantId, String token) {
        @Override public String toString() { return "Credential[REDACTED]"; }
    }

    /** Trusted server-side handle; never reconstruct from client-supplied fields. */
    public record Ownership(UUID roomInstanceId, UUID participantId, long generation, String connectionId) {}
    public enum ClaimStatus { ACQUIRED, ACTIVE, INVALID }
    public record Claim(ClaimStatus status, Ownership owner, Ownership displaced) {}
}
