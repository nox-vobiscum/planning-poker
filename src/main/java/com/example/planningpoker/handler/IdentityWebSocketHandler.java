package com.example.planningpoker.handler;

import com.example.planningpoker.model.Room;
import com.example.planningpoker.service.GameService;
import com.example.planningpoker.service.RoomIdentityRegistry;
import com.example.planningpoker.service.RoomIdentityRegistry.*;
import jakarta.annotation.PreDestroy;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.json.JsonMapper;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;

/** Version 2 admission boundary. No credential is accepted through URLs or legacy CIDs. */
@Component
public class IdentityWebSocketHandler extends TextWebSocketHandler {
    private static final long SECOND = 1_000_000_000L;
    private final GameService service;
    private final GameWebSocketHandler commands;
    private final JsonMapper json = new JsonMapper();
    private final LongSupplier clock;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    // Pending first deliveries reserve a name only until acknowledgement/timeout.
    private final Map<Room, Map<String, String>> reservations = new ConcurrentHashMap<>();
    private final ScheduledExecutorService sweeper;

    @org.springframework.beans.factory.annotation.Autowired
    public IdentityWebSocketHandler(GameService service, GameWebSocketHandler commands) {
        this(service, commands, System::nanoTime, true);
    }

    IdentityWebSocketHandler(GameService service, GameWebSocketHandler commands,
                            LongSupplier clock, boolean schedule) {
        this.service = service;
        this.commands = commands;
        this.clock = clock;
        sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "identity-presence"); t.setDaemon(true); return t;
        });
        if (schedule) sweeper.scheduleAtFixedRate(this::sweep, 5, 5, TimeUnit.SECONDS);
    }

    @PreDestroy public void shutdown() { sweeper.shutdownNow(); }

    @Override public void afterConnectionEstablished(@NonNull WebSocketSession session) {
        // Legacy URLs are rejected, not silently upgraded to a new participation.
        if (session.getUri() != null && session.getUri().getQuery() != null) {
            service.closeSocket(session, new CloseStatus(4406, "Reload required"));
            return;
        }
        session.setTextMessageSizeLimit(8192);
        connections.put(session.getId(), new Connection(session, clock.getAsLong()));
    }

    @Override protected void handleTextMessage(@NonNull WebSocketSession session,
                                               @NonNull TextMessage message) {
        Connection c = connections.get(session.getId());
        if (c == null) return;
        String payload = message.getPayload();
        if (c.room == null) {
            admit(c, payload);
            return;
        }
        service.roomTransaction(c.room, () -> {
            if (connections.get(session.getId()) != c) return;
            if (service.getRoom(c.room.getCode()) != c.room) { reject(c, "invalid", 4401); return; }
            boolean allowed = c.room.identities().runIfOwner(c.owner, () -> {
                if (!c.confirmed) {
                    if (!"identityAck".equals(payload)) { reject(c, "ackRequired", 4401); return; }
                    if (clock.getAsLong() - c.created >= 30 * SECOND) { reject(c, "expired", 4401); return; }
                    activate(c);
                    return;
                }
                if (payload.startsWith("identityPong:")) {
                    String answer = payload.substring("identityPong:".length());
                    if (c.challenge != null && c.challenge.equals(answer)) {
                        c.room.identities().renew(c.owner);
                        c.challenge = null;
                    }
                    return;
                }
                if ("identityAck".equals(payload)) return; // Duplicate acknowledgement is harmless.
                try { commands.handleTextMessage(session, message); }
                catch (Exception ignored) { reject(c, "commandFailed", 1011); }
            });
            if (!allowed) reject(c, "expired", 4408);
        });
    }

    private void admit(Connection c, String payload) {
        try {
            Map<?, ?> request = json.readValue(payload, Map.class);
            if (!Integer.valueOf(2).equals(request.get("version"))) { reject(c, "reloadRequired", 4406); return; }
            String type = string(request, "type");
            String code = string(request, "roomCode").trim();
            if (code.isEmpty() || code.length() > 200) { reject(c, "invalid", 4401); return; }
            boolean resume = "resume".equals(type);
            if (!resume && !"newJoin".equals(type)) { reject(c, "reloadRequired", 4406); return; }
            Room room = resume ? service.getRoom(code) : service.getOrCreateRoom(code);
            if (room == null) { reject(c, "invalid", 4401); return; }
            synchronized (c) {
                if (c.room != null || connections.get(c.session.getId()) != c) return;
                c.room = room;
            }
            service.roomTransaction(room, () -> {
                if (connections.get(c.session.getId()) != c || !c.session.isOpen()) return;
                if (service.getRoom(code) != room || clock.getAsLong() - c.created >= 10 * SECOND) {
                    reject(c, "expired", 4401); return;
                }
                Credential credential;
                if (resume) {
                    try {
                        credential = new Credential(UUID.fromString(string(request, "roomInstanceId")),
                                UUID.fromString(string(request, "participantId")), string(request, "token"));
                    } catch (IllegalArgumentException invalid) { reject(c, "invalid", 4401); return; }
                    var participant = room.getParticipantByCid(credential.participantId().toString()).orElse(null);
                    if (participant == null) { reject(c, "invalid", 4401); return; }
                    c.name = participant.getName();
                } else {
                    c.name = string(request, "participantName").trim();
                    if (c.name.isEmpty() || c.name.length() > 80) { reject(c, "invalid", 4401); return; }
                    Map<String, String> pending = reservations.computeIfAbsent(room, ignored -> new HashMap<>());
                    if (room.nameInUse(c.name) || pending.containsKey(c.name)) {
                        reject(c, "nameTaken", 4005); return;
                    }
                    credential = room.identities().issue();
                    pending.put(c.name, c.session.getId());
                    c.fresh = true;
                }
                Claim claim = room.identities().claim(credential, c.session.getId());
                if (claim.status() != ClaimStatus.ACQUIRED) {
                    reject(c, claim.status() == ClaimStatus.ACTIVE ? "activeElsewhere" : "invalid",
                            claim.status() == ClaimStatus.ACTIVE ? 4409 : 4401);
                    return;
                }
                c.owner = claim.owner();
                if (claim.displaced() != null) {
                    Connection old = connections.get(claim.displaced().connectionId());
                    if (old != null) { detach(old); service.closeSocket(old.session, new CloseStatus(4408, "Expired")); }
                }
                if (resume) activate(c);
                else send(c, Map.of("type", "identityGrant", "roomInstanceId", credential.roomInstanceId().toString(),
                        "participantId", credential.participantId().toString(), "token", credential.token()));
            });
        } catch (Exception ignored) {
            // Deliberately do not log parser exceptions or raw payloads containing secrets.
            reject(c, "invalid", 4401);
        }
    }

    private void activate(Connection c) {
        // Called only within the room's ownership transaction.
        if (!c.fresh && c.room.getParticipantByCid(c.owner.participantId().toString()).isEmpty()) {
            reject(c, "invalid", 4401); return;
        }
        if (c.fresh && c.room.nameInUse(c.name)) { reject(c, "nameTaken", 4005); return; }
        service.join(c.room.getCode(), c.owner.participantId().toString(), c.name);
        c.confirmed = true;
        releaseReservation(c);
        send(c, Map.of("type", "identityReady", "yourName", c.name));
        commands.bindAuthenticated(c.session, c.room, c.owner.participantId().toString(), c.name);
        challenge(c);
    }

    private void challenge(Connection c) {
        if (c.challenge == null) c.challenge = UUID.randomUUID().toString();
        c.lastChallenge = clock.getAsLong();
        send(c, Map.of("type", "identityChallenge", "nonce", c.challenge));
    }

    void sweep() {
        for (Connection c : connections.values()) {
            try {
                Room room = c.room;
                if (room == null) {
                    if (clock.getAsLong() - c.created >= 10 * SECOND) reject(c, "reloadRequired", 4406);
                    continue;
                }
                service.roomTransaction(room, () -> {
                    if (connections.get(c.session.getId()) != c) return;
                    if (service.getRoom(room.getCode()) != room ||
                            !room.identities().runIfOwner(c.owner, () -> {})) {
                        reject(c, "expired", 4408);
                    } else if (!c.confirmed && clock.getAsLong() - c.created >= 30 * SECOND) {
                        reject(c, "expired", 4401);
                    } else if (c.confirmed && clock.getAsLong() - c.lastChallenge >= 15 * SECOND) {
                        challenge(c);
                    }
                });
            } catch (Exception ignored) { /* One failed socket must not stop expiration. */ }
        }
    }

    private void send(Connection c, Map<String, ?> response) {
        try { service.sendText(c.session, json.writeValueAsString(response)); }
        catch (Exception ignored) { /* Close/timeout performs cleanup. */ }
    }

    private void reject(Connection c, String reason, int code) {
        send(c, Map.of("type", "identityError", "reason", reason));
        if (c.room != null) service.roomTransaction(c.room, () -> detach(c));
        else connections.remove(c.session.getId(), c);
        service.closeSocket(c.session, new CloseStatus(code, reason));
    }

    private void releaseReservation(Connection c) {
        Map<String, String> pending = reservations.get(c.room);
        if (pending != null) {
            pending.remove(c.name, c.session.getId());
            if (pending.isEmpty()) reservations.remove(c.room, pending);
        }
    }

    private void detach(Connection c) {
        if (!connections.remove(c.session.getId(), c)) return;
        commands.forgetAuthenticated(c.session);
        releaseReservation(c);
        if (c.owner == null) return;
        if (c.fresh && !c.confirmed) {
            c.room.identities().revoke(c.owner.participantId());
        } else if (c.room.identities().release(c.owner)) {
            service.scheduleDisconnect(c.room, c.owner);
        }
    }

    @Override public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) {
        Connection c = connections.get(session.getId());
        if (c == null) return;
        if (c.room == null) connections.remove(session.getId(), c);
        else service.roomTransaction(c.room, () -> detach(c));
    }

    @Override public void handleTransportError(@NonNull WebSocketSession session, @NonNull Throwable exception) {
        afterConnectionClosed(session, CloseStatus.SERVER_ERROR);
        service.closeSocket(session, CloseStatus.SERVER_ERROR);
    }

    private static String string(Map<?, ?> request, String key) {
        Object value = request.get(key);
        return value instanceof String text ? text : "";
    }

    private static final class Connection {
        final WebSocketSession session;
        final long created;
        volatile Room room;
        Ownership owner;
        String name;
        boolean fresh;
        boolean confirmed;
        String challenge;
        long lastChallenge;
        Connection(WebSocketSession session, long created) { this.session = session; this.created = created; }
    }
}