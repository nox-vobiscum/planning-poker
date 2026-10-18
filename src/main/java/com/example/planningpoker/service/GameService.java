package com.example.planningpoker.service;

import com.example.planningpoker.model.CardSequences;
import com.example.planningpoker.model.Participant;
import com.example.planningpoker.model.Room;
import com.example.planningpoker.rooms.service.RoomSnapshotter;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.core.JacksonException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Game service: room state, participants, voting, topic, auto-reveal, host rotation & presence toasts. */
@Service
public class GameService {

    private static final Logger log = LoggerFactory.getLogger(GameService.class);

    // --- optional snapshot hook (non-fatal, may be null) ---
    private final RoomSnapshotter snapshotter;
    private java.util.function.LongSupplier identityClock = System::nanoTime;

    /** Monotonic clock seam for deterministic identity/lifecycle tests. */
    public GameService(java.util.function.LongSupplier identityClock) {
        this();
        this.identityClock = Objects.requireNonNull(identityClock);
    }

    public GameService(java.util.function.LongSupplier identityClock, ScheduledExecutorService scheduler) {
        this(identityClock);
        this.scheduler.shutdownNow();
        this.scheduler = Objects.requireNonNull(scheduler);
    }

    /** Default ctor for tests (no Spring context): snapshotter stays null. */
    public GameService() {
        this.snapshotter = null;
    }

    /** Spring-injected provider (preferred at runtime). */
    @Autowired
    public GameService(ObjectProvider<RoomSnapshotter> snapshotterProvider) {
        this.snapshotter = (snapshotterProvider != null ? snapshotterProvider.getIfAvailable() : null);
    }

    private void snapshot(Room room, String actor) {
        if (snapshotter != null && room != null) {
            snapshotter.onChange(room, (actor != null && !actor.isBlank()) ? actor : "system");
        }
    }

    // --- in-memory state ---
    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final Map<WebSocketSession, Room> sessionToRoomMap = new ConcurrentHashMap<>();
    private final Map<WebSocketSession, String> sessionToParticipantMap = new ConcurrentHashMap<>();

    // Specials selection per room (optional; falls back to boolean allowSpecials)
    private final Map<String, List<String>> roomSpecialsSelected = new ConcurrentHashMap<>();

    // Stable client-id per tab -> last known name in that room
    private final Map<String, String> clientToName = new ConcurrentHashMap<>();
    private static String mapKey(String roomCode, String cid) { return roomCode.length() + ":" + roomCode + "|" + cid; }
    public String getClientName(String roomCode, String cid) {
        if (cid == null) return null;
        return clientToName.get(mapKey(roomCode, cid));
    }
    public void rememberClientName(String roomCode, String cid, String name) {
        if (cid != null && name != null && !name.isBlank()) {
            clientToName.put(mapKey(roomCode, cid), name);
        }
    }

    // Defer network I/O until the identity/game-state transaction releases Room.
    private final ThreadLocal<List<Runnable>> outbound = new ThreadLocal<>();
    public void roomTransaction(Room room, Runnable action) {
        if (outbound.get() != null) {
            synchronized (room) { action.run(); }
            return;
        }
        List<Runnable> pending = new ArrayList<>();
        outbound.set(pending);
        try { synchronized (room) { action.run(); } }
        finally {
            outbound.remove();
            for (Runnable send : pending) send.run();
        }
    }

    public void closeSocket(WebSocketSession session, CloseStatus status) {
        Runnable close = () -> { try { session.close(status); } catch (IOException ignored) {} };
        if (outbound.get() != null) outbound.get().add(close);
        else close.run();
    }


    private final JsonMapper objectMapper = new JsonMapper();

    // --- disconnect & host grace ---
    private static final long LEAVE_GRACE_MS = 2_000L;
    private static final long HOST_GRACE_UNEXPECTED_MS = 5_000L;
    private static final long HOST_GRACE_INTENTIONAL_MS = 2_000L;

    private ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "presence-grace");
                t.setDaemon(true);
                return t;
            });

    private final Map<String, ScheduledFuture<?>> pendingDisconnects = new ConcurrentHashMap<>();
    private final Map<String, ScheduledFuture<?>> pendingHostTransfers = new ConcurrentHashMap<>();

    private static String key(Room room, String name) { return room.getCode() + "|" + name; }

    // --- rooms ---
    public Room getOrCreateRoom(String roomCode) { return rooms.computeIfAbsent(roomCode, code -> new Room(code, identityClock)); }
    public Room getRoom(String roomCode) { return rooms.get(roomCode); }
    public Room room(String roomCode) { return getRoom(roomCode); }

    public record NameAvailability(boolean available, String suggestion) {}

    /** Advisory only: the WebSocket handshake performs the final atomic reservation. */
    public NameAvailability nameAvailability(String roomCode, String requestedName) {
        String code = roomCode == null ? "" : roomCode.trim();
        String name = requestedName == null ? "" : requestedName.trim();
        Room room = getRoom(code); // Never create a room or read a persisted snapshot.
        if (room == null || name.isEmpty()) return new NameAvailability(true, name);
        synchronized (room) {
            if (!room.nameUnavailable(name)) return new NameAvailability(true, name);
            String base = name.replaceFirst(" \\([0-9]+\\)$", "");
            String suggestion = base;
            for (int suffix = 2; room.nameUnavailable(suggestion); suffix++) {
                suggestion = base + " (" + suffix + ")";
            }
            return new NameAvailability(false, suggestion);
        }
    }

    // --- ws session tracking ---
    public void addSession(WebSocketSession session, Room room) { sessionToRoomMap.put(session, room); }
    public void trackParticipant(WebSocketSession session, String participantName) { sessionToParticipantMap.put(session, participantName); }
    public Room getRoomForSession(WebSocketSession session) { return sessionToRoomMap.get(session); }
    public String getParticipantName(WebSocketSession session) { return sessionToParticipantMap.get(session); }
    public void removeSession(WebSocketSession session) {
        sessionToRoomMap.remove(session);
        sessionToParticipantMap.remove(session);
    }

    public boolean hasOpenSession(Room room, String participantName) {
        if (room == null || participantName == null) return false;
        for (Map.Entry<WebSocketSession, Room> entry : sessionToRoomMap.entrySet()) {
            WebSocketSession session = entry.getKey();
            if (entry.getValue() == room
                    && session.isOpen()
                    && participantName.equals(sessionToParticipantMap.get(session))) {
                return true;
            }
        }
        return false;
    }

    // ========================================================================
    //  JOIN / RENAME
    // ========================================================================

    public Room join(String roomCode, String cid, String requestedName) {
        Room room = getOrCreateRoom(roomCode);
        String desired = normalizeName(requestedName);
        String actor = null;
        boolean created = false; // announce "participantJoined" only when a brand-new participant is created

        synchronized (room) {
            Participant byCid = room.getParticipantByCid(cid).orElse(null);
            if (byCid != null) {
                byCid.setActive(true);
                byCid.bumpLastSeen();
                if (room.getHost() == null) byCid.setHost(true);
                rememberClientName(roomCode, cid, byCid.getName());
                cancelPresenceTimers(room, byCid.getName());
                actor = byCid.getName();
            } else {
                String unique = uniqueNameFor(room, desired, null);
                Participant p = new Participant(unique);
                p.setActive(true);
                p.setParticipating(true);
                p.bumpLastSeen();
                if (room.getHost() == null) p.setHost(true);

                room.addParticipant(p);
                room.linkCid(cid, unique);
                rememberClientName(roomCode, cid, unique);
                cancelPresenceTimers(room, unique);
                actor = unique;
                created = true;
            }
        }

        // Send full state to everyone
        broadcastRoomState(room);

        // Additionally announce a JSON participantJoined to all current sessions
        if (created && actor != null && !actor.isBlank()) {
            broadcastParticipantJoined(room, actor);
        }

        snapshot(room, actor);
        return room;
    }

    public String renameParticipant(String roomCode, String cid, String requestedName) {
        Room room = getRoom(roomCode);
        if (room == null || cid == null) return null;

        String oldName = null;
        String finalName;

        synchronized (room) {
            Participant cur = room.getParticipantByCid(cid).orElse(null);
            String desired = (requestedName == null ? "" : requestedName.trim());
            if (desired.isEmpty()) desired = "Guest";

            if (cur == null) {
                String unique = uniqueNameFor(room, desired, null);
                Participant p = room.getParticipant(unique);
                if (p == null) {
                    p = new Participant(unique);
                    p.setActive(true);
                    p.setParticipating(true);
                    p.bumpLastSeen();
                    if (room.getHost() == null) p.setHost(true);
                    room.addParticipant(p);
                }
                room.linkCid(cid, p.getName());
                finalName = p.getName();
            } else {
                oldName = cur.getName();
                String unique = uniqueNameFor(room, desired, oldName);
                if (unique.equals(oldName)) {
                    finalName = oldName;
                } else {
                    Participant repl = new Participant(unique);
                    repl.setActive(cur.isActive());
                    repl.setParticipating(cur.isParticipating());
                    repl.setHost(cur.isHost());
                    repl.setVote(cur.getVote());

                    room.addParticipant(repl);
                    room.linkCid(cid, unique);
                    room.removeParticipant(oldName);

                    finalName = unique;
                }
            }

            rememberClientName(roomCode, cid, finalName);
        }

        if (oldName != null && !Objects.equals(oldName, finalName)) {
            broadcastParticipantRenamed(room, oldName, finalName);
        }
        broadcastRoomState(room);
        snapshot(room, finalName);
        return finalName;
    }

    private static String uniqueNameFor(Room room, String desired, String selfName) {
        String base = (desired == null || desired.isBlank()) ? "Guest" : desired.trim();
        String candidate = base;
        int suffix = 2;

        while (true) {
            Participant clash = room.getParticipant(candidate);
            if (clash == null || (selfName != null && selfName.equals(candidate))) {
                return candidate;
            }
            candidate = base + " (" + suffix + ")";
            suffix++;
        }
    }

    private static String normalizeName(String s) {
        String t = (s == null) ? "" : s.trim();
        if (t.isEmpty()) t = "Guest";
        if (t.length() > 80) t = t.substring(0, 80);
        return t;
    }

    // ========================================================================
    //  PRESENCE / VOTE / TOPIC / SEQUENCE / HOSTING
    // ========================================================================

    public void setVote(String roomCode, String nameOrCid, String value) {
        Room room = getOrCreateRoom(roomCode);
        String actor;
        synchronized (room) {
            Participant p = room.getParticipantByCid(nameOrCid).orElse(null);
            if (p == null) p = room.getParticipant(nameOrCid);
            if (p == null) {
                p = new Participant(nameOrCid);
                room.addParticipant(p);
            }
            p.setVote(value);
            p.bumpLastSeen();
            actor = p.getName();

            if (room.isAutoRevealEnabled() && !room.areVotesRevealed() && allActiveParticipantsHaveValidVotes(room)) {
                room.setCardsRevealed(true);
            }
        }
        broadcastRoomState(room);
        snapshot(room, actor);
    }

    public void reveal(String roomCode) {
        Room room = getOrCreateRoom(roomCode);
        String actor = null;
        synchronized (room) {
            room.setCardsRevealed(true);
            Participant host = room.getHost();
            actor = (host != null ? host.getName() : null);
        }
        broadcastRoomState(room);
        snapshot(room, actor);
    }

    public void reset(String roomCode) {
        Room room = getOrCreateRoom(roomCode);
        String actor = null;
        synchronized (room) {
            room.reset();
            Participant host = room.getHost();
            actor = (host != null ? host.getName() : null);
        }
        broadcastRoomState(room);
        snapshot(room, actor);
    }

    public void saveTopic(String roomCode, String input) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) {
            String[] parsed = parseTopic(input);
            room.setTopicLabel(parsed[0]);
            room.setTopicUrl(parsed[1]);
            room.setTopicVisible(true);
        }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    public void clearTopic(String roomCode) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) {
            room.setTopicLabel(null);
            room.setTopicUrl(null);
            room.setTopicVisible(false);
        }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    public void setTopicEnabled(String roomCode, boolean enabled) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) { room.setTopicVisible(enabled); }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    public void setAutoRevealEnabled(String roomCode, boolean enabled) {
        Room room = getOrCreateRoom(roomCode);
        boolean flippedToRevealed = false;
        synchronized (room) {
            room.setAutoRevealEnabled(enabled);
            if (enabled && !room.areVotesRevealed() && allActiveParticipantsHaveValidVotes(room)) {
                room.setCardsRevealed(true);
                flippedToRevealed = true;
            }
        }
        if (flippedToRevealed && log.isDebugEnabled()) {
            log.debug("Auto-reveal: immediately revealing room={} (all votes present)", roomCode);
        }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    /**
     * Legacy boolean API (compatibility).
     * When disabled → clear selection and remove special votes.
     * When enabled and no selection present → default to global SPECIALS.
     */
    public void setAllowSpecials(String roomCode, boolean allow) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) {
            room.setAllowSpecials(allow);
            if (!allow) {
                roomSpecialsSelected.put(room.getCode(), Collections.emptyList());
                for (Participant p : room.getParticipants()) {
                    String v = p.getVote();
                    if (CardSequences.isSpecial(v)) p.setVote(null);
                }
            } else {
                roomSpecialsSelected.computeIfAbsent(room.getCode(), k -> new ArrayList<>(CardSequences.SPECIALS));
            }
        }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    /**
     * Normalize incoming special identifiers: try IDs→emojis first, then accept emojis.
     */
    private List<String> normalizeSpecials(List<String> in) {
        if (in == null || in.isEmpty()) return List.of();
        // First, try to interpret as IDs and map to emojis.
        List<String> byId = CardSequences.idsToEmojis(in);
        if (!byId.isEmpty()) return byId;
        // Otherwise assume emojis and filter to known specials.
        List<String> emojis = new ArrayList<>();
        for (String s : in) {
            if (CardSequences.isSpecial(s)) emojis.add(s);
        }
        return emojis;
    }

    /**
     * New API: set selected specials (empty list = disable all specials).
     * Accepts either IDs (e.g., "coffee") or emojis ("☕").
     * Invalid values are filtered. Any vote using a now-disallowed special is cleared.
     */
    public void setSpecialsSelected(String roomCode, List<String> specials) {
        Room room = getOrCreateRoom(roomCode);
        List<String> cleaned = normalizeSpecials(specials);
        boolean allow = !cleaned.isEmpty();

        synchronized (room) {
            room.setAllowSpecials(allow);
            roomSpecialsSelected.put(room.getCode(), Collections.unmodifiableList(cleaned));

            // Remove votes that are no longer allowed
            if (!allow) {
                for (Participant p : room.getParticipants()) {
                    if (CardSequences.isSpecial(p.getVote())) p.setVote(null);
                }
            } else {
                for (Participant p : room.getParticipants()) {
                    String v = p.getVote();
                    if (CardSequences.isSpecial(v) && !cleaned.contains(v)) {
                        p.setVote(null);
                    }
                }
            }
        }

        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    /** Core method used by both "self" (by cid) and "host" (by name) spectator toggles. */
    public void setSpectator(String roomCode, String nameOrCid, boolean spectator) {
        Room room = getOrCreateRoom(roomCode);
        String actor = null;
        synchronized (room) {
            Participant p = room.getParticipantByCid(nameOrCid).orElse(null);
            if (p == null) p = room.getParticipant(nameOrCid);

            if (p == null) {
                p = new Participant(nameOrCid);
                room.addParticipant(p);
            }
            boolean participating = !spectator;
            p.setParticipating(participating);
            if (!participating) p.setVote(null);
            p.bumpLastSeen();
            actor = p.getName();
        }
        log.info("setSpectator room={} target={} spectator={} (participating={})",
                roomCode, nameOrCid, spectator, !spectator);
        broadcastRoomState(room);
        snapshot(room, actor);
    }

    /** Host action convenience: set a target's participating flag by name. */
    public void setParticipatingFor(String roomCode, String targetName, boolean participating) {
        setSpectator(roomCode, targetName, !participating);
    }

    /** Keep-alive ping to keep presence fresh (no snapshot). */
    public void touch(String roomCode, String nameOrCid) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) {
            Participant p = room.getParticipantByCid(nameOrCid).orElse(null);
            if (p == null) p = room.getParticipant(nameOrCid);
            if (p != null) {
                p.setActive(true);
                p.bumpLastSeen();
            }
        }
    }

    public void setSequence(String roomCode, String sequenceId) {
        Room room = getOrCreateRoom(roomCode);
        synchronized (room) {
            String normalized = sanitizeSequenceId(sequenceId);
            room.setSequenceId(normalized);
            room.reset();
        }
        broadcastRoomState(room);
        snapshot(room, "ws");
    }

    public void makeHost(String roomCode, String targetName) {
        Room room = getRoom(roomCode);
        if (room == null || targetName == null) return;

        String oldHost = null;
        synchronized (room) {
            Participant target = room.getParticipant(targetName);
            if (target == null) return;
            Participant cur = room.getHost();
            if (cur != null) {
                oldHost = cur.getName();
                cur.setHost(false);
            }
            target.setHost(true);
            target.bumpLastSeen();
        }
        broadcastHostChange(room, oldHost, targetName);
        broadcastRoomState(room);
        snapshot(room, targetName);
    }

    public boolean shouldAutoReveal(String roomCode) {
        Room room = getRoom(roomCode);
        if (room == null) return false;
        synchronized (room) {
            return room.isAutoRevealEnabled()
                    && !room.areVotesRevealed()
                    && allActiveParticipantsHaveValidVotes(room);
        }
    }

    public void ensureHost(String roomCode, long softMs, long hardMs) {
        Room room = getRoom(roomCode);
        if (room == null) return;

        String oldHost = null;
        String newHost = null;

        synchronized (room) {
            Participant host = room.getHost();
            long now = System.currentTimeMillis();

            if (host == null) {
                newHost = room.assignNewHostIfNecessary(null);
            } else {
                long idle = now - host.getLastSeenAt();
                if (!host.isActive() || idle >= hardMs) {
                    oldHost = host.getName();
                    host.setHost(false);
                    newHost = room.assignNewHostIfNecessary(oldHost);
                }
            }
        }

        if (newHost != null) {
            broadcastHostChange(room, oldHost, newHost);
            broadcastRoomState(room);
            snapshot(room, newHost);
        }
    }

    // ========================================================================
    //  CALCULATIONS
    // ========================================================================

    public OptionalDouble calculateAverageVote(Room room) {
        Map<String, Double> nv = collectNumericVotes(room);
        return nv.values().stream().mapToDouble(Double::doubleValue).average();
    }

    public OptionalDouble calculateMedian(Room room) {
        Map<String, Double> nv = collectNumericVotes(room);
        if (nv.isEmpty()) return OptionalDouble.empty();
        List<Double> sorted = new ArrayList<>(nv.values());
        sorted.sort(Comparator.naturalOrder());
        int n = sorted.size();
        if (n % 2 == 1) return OptionalDouble.of(sorted.get(n / 2));
        double m = (sorted.get(n / 2 - 1) + sorted.get(n / 2)) / 2.0;
        return OptionalDouble.of(m);
    }

    public String calculateRange(Room room, Locale locale) {
        Map<String, Double> nv = collectNumericVotes(room);
        if (nv.isEmpty()) return null;
        double min = nv.values().stream().mapToDouble(Double::doubleValue).min().orElse(Double.NaN);
        double max = nv.values().stream().mapToDouble(Double::doubleValue).max().orElse(Double.NaN);
        if (Double.isNaN(min) || Double.isNaN(max)) return null;

        String minS = CardSequences.formatAverage(OptionalDouble.of(min), locale);
        String maxS = CardSequences.formatAverage(OptionalDouble.of(max), locale);
        return minS + "–" + maxS;
    }

    /** Consensus now fails immediately if any active participant selected ∞. */
    public boolean isConsensus(Room room) {
        if (room == null) return false;

        List<String> votes = new ArrayList<>();
        for (Participant p : room.getParticipants()) {
            if (p.isActive() && p.isParticipating()) {
                String v = p.getVote();
                if (v != null) votes.add(v);
            }
        }
        return CardSequences.isConsensus(votes);
    }

    /** Detects at least one active, participating vote of ∞. */
    private boolean hasInfinityVote(Room room) {
        if (room == null) return false;
        for (Participant p : room.getParticipants()) {
            if (!p.isActive() || !p.isParticipating()) continue;
            String v = p.getVote();
            if (v == null) continue;
            if ("∞".equals(v) || "♾".equals(v) || "♾️".equals(v)) return true;
        }
        return false;
    }

    private Map<String, Double> collectNumericVotes(Room room) {
        Map<String, Double> out = new LinkedHashMap<>();
        if (room == null) return out;
        Set<String> seen = new HashSet<>();
        for (Participant p : room.getParticipants()) {
            if (!p.isActive() || !p.isParticipating()) continue;
            if (!seen.add(p.getName())) continue;
            String v = p.getVote();
            OptionalDouble num = CardSequences.parseNumeric(v); // specials (incl. ∞) -> empty
            if (num.isPresent()) out.put(p.getName(), num.getAsDouble());
        }
        return out;
    }

    public boolean isValidVote(String v) {
        return v != null && !CardSequences.SPECIALS.contains(v);
    }

    public boolean allActiveParticipantsHaveValidVotes(Room room) {
        if (room == null) return false;
        for (Participant p : room.getParticipants()) {
            if (p.isActive() && p.isParticipating()) {
                String v = p.getVote();
                if (v == null || !isValidVote(v)) return false;
            }
        }
        return true;
    }

    // ========================================================================
    //  ROOM STATE JSON / SENDERS
    // ========================================================================

    private List<String> getSelectedSpecials(Room room) {
        if (room == null) return Collections.emptyList();
        List<String> sel = roomSpecialsSelected.get(room.getCode());
        if (!room.isAllowSpecials()) return Collections.emptyList();
        if (sel == null) return new ArrayList<>(CardSequences.SPECIALS);
        return sel;
    }

    /** Build the full room-state JSON payload once so both broadcast and targeted send can reuse it. */
    private String buildRoomStateJson(Room room) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "voteUpdate");

        List<Participant> ordered = getOrderedParticipants(room);
        Map<String, Map<String, Object>> byName = new LinkedHashMap<>();
        for (Participant p : ordered) {
            Map<String, Object> cur = byName.get(p.getName());
            boolean away = pendingDisconnects.containsKey(key(room, p.getName()));
            if (cur == null) {
                cur = new HashMap<>();
                cur.put("name", p.getName());
                cur.put("vote", p.getVote());
                cur.put("disconnected", !p.isActive());
                cur.put("away", away);
                cur.put("isHost", p.isHost());
                cur.put("participating", p.isParticipating());
                // Optional convenience (UI can also derive this): spectator = !participating
                cur.put("spectator", !p.isParticipating());
                byName.put(p.getName(), cur);
            } else {
                if (p.getVote() != null) cur.put("vote", p.getVote());
                if (p.isHost()) cur.put("isHost", true);
                if (p.isParticipating()) cur.put("participating", true);
                if (p.isActive()) cur.put("disconnected", false);
                if (!away) cur.put("away", false);
                cur.put("spectator", !Boolean.TRUE.equals(cur.get("participating")));
            }
        }
        payload.put("participants", new ArrayList<>(byName.values()));

        boolean revealed = room.areVotesRevealed();
        payload.put("votesRevealed", revealed);

        Locale loc = Locale.getDefault();

        OptionalDouble avg = calculateAverageVote(room);
        String avgDisplay = avg.isPresent()
                ? CardSequences.formatAverage(avg, loc)
                : "-";
        payload.put("averageVote", revealed ? avgDisplay : null);

        Map<String, Double> numeric = collectNumericVotes(room);
        int n = numeric.size();

        if (revealed && n >= 2) {
            OptionalDouble med = calculateMedian(room);
            payload.put("medianVote", med.isPresent() ? CardSequences.formatAverage(med, loc) : null);

            String range = calculateRange(room, loc);
            payload.put("range", range);
        } else {
            payload.put("medianVote", null);
            payload.put("range", null);
        }

        boolean consensus = revealed && isConsensus(room);
        payload.put("consensus", consensus);

        if (revealed && n >= 3) {
            List<String> outliers = farthestFromAverageNames(room);
            payload.put("outliers", outliers);
        } else {
            payload.put("outliers", List.of());
        }

        // Infinity annotation for UI "(+ ♾️)"
        payload.put("hasInfinity", revealed && hasInfinityVote(room));

        payload.put("sequenceId", room.getSequenceId());

        // Deck: start with room's base deck and filter specials depending on selection
        List<String> baseDeck = new ArrayList<>(room.getCurrentCards());
        Set<String> specialsAll = new HashSet<>(CardSequences.SPECIALS);
        List<String> sel = getSelectedSpecials(room);
        if (!sel.isEmpty()) {
            Set<String> allowed = new HashSet<>(sel);
            baseDeck.removeIf(c -> specialsAll.contains(c) && !allowed.contains(c));
        } else {
            // no specials allowed
            baseDeck.removeIf(specialsAll::contains);
        }
        payload.put("cards", baseDeck);

        payload.put("specials", sel); // selected specials (client has back-compat)
        payload.put("autoRevealEnabled", room.isAutoRevealEnabled());
        payload.put("allowSpecials", room.isAllowSpecials());

        payload.put("topicLabel", room.getTopicLabel());
        payload.put("topicUrl", room.getTopicUrl());
        payload.put("topicVisible", room.isTopicVisible());

        payload.put("specialsEnabled", room.isAllowSpecials()); // legacy alias

        return objectMapper.writeValueAsString(payload);
    }

    /** Send full room state to everyone in the room. */
    public void broadcastRoomState(Room room) {
        try {
            String json = buildRoomStateJson(room);
            broadcastToRoom(room, json);
        } catch (JacksonException e) {
            e.printStackTrace();
        }
    }

    /** Targeted: send full room state only to the given session. */
    public void sendRoomState(WebSocketSession session, Room room) {
        if (session == null || room == null) return;
        try {
            String json = buildRoomStateJson(room);
            sendText(session, json);
        } catch (IOException | JacksonException e) {
            e.printStackTrace();
        }
    }

    // Aliases for reflection/back-compat used by GameWebSocketHandler
    public void sendRoomState(Room room, WebSocketSession session) { sendRoomState(session, room); }
    public void sendRoomSnapshot(WebSocketSession session, Room room) { sendRoomState(session, room); }
    public void sendStateTo(WebSocketSession session, Room room) { sendRoomState(session, room); }
    public void sendStateTo(WebSocketSession session, String roomCode) {
        Room r = getRoom(roomCode);
        if (r != null) sendRoomState(session, r);
    }
    public void broadcastRoom(Room room) { broadcastRoomState(room); }
    public void broadcast(Room room) { broadcastRoomState(room); }

    /** Low-level broadcast utility. */
    public void broadcastToRoom(Room room, String message) {
        sessionToRoomMap.entrySet().removeIf(entry -> {
            WebSocketSession session = entry.getKey();
            if (!entry.getValue().equals(room)) return false;

            try {
                return !sendText(session, message);
            } catch (IOException e) {
                e.printStackTrace();
                return true;
            }
        });
    }

    /** Defer transaction output, then serialize writes per connection without changing payloads. */
    public boolean sendText(WebSocketSession session, String message) throws IOException {
        if (outbound.get() != null) {
            outbound.get().add(() -> {
                try { sendText(session, message); }
                catch (IOException ignored) { removeSession(session); }
            });
            return session.isOpen();
        }
        synchronized (session) {
            if (!session.isOpen()) return false;
            session.sendMessage(new TextMessage(message));
            return true;
        }
    }

    public void broadcastHostChange(Room room, String oldHostName, String newHostName) {
        try {
            Map<String, Object> legacy = new HashMap<>();
            legacy.put("type", "hostChanged");
            legacy.put("oldHost", oldHostName);
            legacy.put("newHost", newHostName);
            broadcastToRoom(room, objectMapper.writeValueAsString(legacy));
        } catch (JacksonException ignored) {}

        Map<String, Object> modern = new HashMap<>();
        modern.put("type", "hostTransferred");
        modern.put("from", oldHostName);
        modern.put("to", newHostName);
        try {
            broadcastToRoom(room, objectMapper.writeValueAsString(modern));
        } catch (Exception ignored) { }
    }

    private List<Participant> getOrderedParticipants(Room room) {
        List<Participant> all = new ArrayList<>(room.getParticipants());
        Participant host = room.getHost();
        if (host != null) {
            all.removeIf(p -> p.getName().equals(host.getName()));
            List<Participant> ordered = new ArrayList<>();
            ordered.add(host);
            ordered.addAll(all);
            return ordered;
        }
        return all;
    }

    // ========================================================================
    //  DISCONNECTS / KICK / CLOSE
    // ========================================================================

    private void cancelPresenceTimers(Room room, String participantName) {
        String k = key(room, participantName);
        ScheduledFuture<?> f = pendingDisconnects.remove(k);
        if (f != null) f.cancel(false);

        ScheduledFuture<?> h = pendingHostTransfers.remove(k);
        if (h != null) h.cancel(false);
    }

    public void cancelPendingDisconnect(Room room, String participantName) {
        cancelPresenceTimers(room, participantName);
    }

    public void scheduleDisconnect(Room room, RoomIdentityRegistry.Ownership owner) {
        Runnable inactive = () -> roomTransaction(room, () -> {
            if (getRoom(room.getCode()) != room || !room.identities().isDisconnected(owner)) return;
            Participant p = room.getParticipantByCid(owner.participantId().toString()).orElse(null);
            if (p == null) return;
            p.setActive(false);
            broadcastParticipantLeft(room, p.getName());
            broadcastRoomState(room);
            snapshot(room, p.getName());
        });
        scheduler.schedule(inactive, LEAVE_GRACE_MS, TimeUnit.MILLISECONDS);
        scheduler.schedule(() -> roomTransaction(room, () -> {
            if (getRoom(room.getCode()) != room || !room.identities().isDisconnected(owner)) return;
            Participant p = room.getParticipantByCid(owner.participantId().toString()).orElse(null);
            if (p == null || !p.isHost() || p.isActive()) return;
            p.setHost(false);
            String next = room.assignNewHostIfNecessary(p.getName());
            if (next != null) broadcastHostChange(room, p.getName(), next);
            broadcastRoomState(room);
            snapshot(room, p.getName());
        }), HOST_GRACE_UNEXPECTED_MS, TimeUnit.MILLISECONDS);
    }

    public void scheduleDisconnect(Room room, String participantName) {
        schedulePresence(room, participantName, LEAVE_GRACE_MS, HOST_GRACE_UNEXPECTED_MS);
    }

    public void scheduleIntentionalDisconnect(Room room, String participantName) {
        if (room == null || participantName == null) return;

        cancelPresenceTimers(room, participantName);

        broadcastParticipantLeft(room, participantName);

        synchronized (room) {
            Participant p = room.getParticipant(participantName);
            if (p != null) p.setActive(false);
        }
        broadcastRoomState(room);
        snapshot(room, participantName);

        scheduleHostTransfer(room, participantName, HOST_GRACE_INTENTIONAL_MS);
    }

    public void handleIntentionalLeave(String roomCode, String participantName) {
        Room room = getRoom(roomCode);
        if (room != null && participantName != null) {
            scheduleIntentionalDisconnect(room, participantName);
        }
    }

    private void schedulePresence(Room room, String participantName, long leaveDelayMs, long hostDelayMs) {
        if (room == null || participantName == null) return;
        String k = key(room, participantName);

        cancelPresenceTimers(room, participantName);

        broadcastRoomState(room);

        ScheduledFuture<?> leaveF = scheduler.schedule(() -> {
            try {
                synchronized (room) {
                    Participant participant = room.getParticipant(participantName);
                    if (participant != null) participant.setActive(false);
                }
                broadcastParticipantLeft(room, participantName);
                broadcastRoomState(room);
                snapshot(room, participantName);
            } finally {
                pendingDisconnects.remove(k);
            }
        }, leaveDelayMs, TimeUnit.MILLISECONDS);
        pendingDisconnects.put(k, leaveF);

        scheduleHostTransfer(room, participantName, hostDelayMs);
    }

    private void scheduleHostTransfer(Room room, String leavingName, long delayMs) {
        if (room == null || leavingName == null) return;
        String k = key(room, leavingName);

        ScheduledFuture<?> hostF = scheduler.schedule(() -> {
            try {
                String newHostName = null;
                synchronized (room) {
                    Participant host = room.getHost();
                    Participant leaving = room.getParticipant(leavingName);
                    boolean actuallyGone = (leaving == null) || !leaving.isActive();

                    // Transfer host ONLY if the leaving participant is still the host AND actually gone
                    if (host != null && Objects.equals(host.getName(), leavingName) && actuallyGone) {
                        host.setHost(false);
                        newHostName = room.assignNewHostIfNecessary(leavingName);
                    }
                }
                if (newHostName != null) {
                    broadcastHostChange(room, leavingName, newHostName);
                    broadcastRoomState(room);
                    snapshot(room, newHostName);
                }
            } finally {
                pendingHostTransfers.remove(k);
            }
        }, delayMs, TimeUnit.MILLISECONDS);

        pendingHostTransfers.put(k, hostF);
}

    private void broadcastParticipantLeft(Room room, String name) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "participantLeft");
        payload.put("name", name);
        try {
            broadcastToRoom(room, objectMapper.writeValueAsString(payload));
        } catch (JacksonException ignored) { }
    }

    private void broadcastParticipantRenamed(Room room, String from, String to) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "participantRenamed");
        payload.put("from", from);
        payload.put("to", to);
        try {
            broadcastToRoom(room, objectMapper.writeValueAsString(payload));
        } catch (JacksonException ignored) { }
    }

    private void broadcastParticipantJoined(Room room, String name) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "participantJoined");
        payload.put("name", name);
        try {
            broadcastToRoom(room, objectMapper.writeValueAsString(payload));
        } catch (JacksonException ignored) { }
    }

    public void revokeParticipantIdentity(Room room, String name) {
        clientToName.entrySet().removeIf(entry -> {
            if (!entry.getKey().startsWith(mapKey(room.getCode(), "")) || !entry.getValue().equals(name)) return false;
            String id = entry.getKey().substring(mapKey(room.getCode(), "").length());
            try { room.identities().revoke(UUID.fromString(id)); } catch (IllegalArgumentException ignored) {}
            return true;
        });
    }

    /** Explicit exit is final; invalidate before releasing the name. */
    public void exitParticipant(Room room, String name) {
        cancelPresenceTimers(room, name);
        revokeParticipantIdentity(room, name);
        for (WebSocketSession session : new ArrayList<>(sessionToRoomMap.keySet())) {
            if (sessionToRoomMap.get(session) == room && name.equals(sessionToParticipantMap.get(session))) {
                removeSession(session);
                try { sendText(session, "{\"type\":\"exited\"}"); } catch (IOException ignored) {}
                closeSocket(session, new CloseStatus(4400, "Participation ended"));
            }
        }
        room.removeParticipant(name);
        // Keep the intentional-leave host grace; the removed host is no longer eligible.
        scheduler.schedule(() -> roomTransaction(room, () -> {
            if (getRoom(room.getCode()) != room) return;
            String next = room.assignNewHostIfNecessary(null);
            if (next != null) broadcastHostChange(room, name, next);
            broadcastRoomState(room);
        }), HOST_GRACE_INTENTIONAL_MS, TimeUnit.MILLISECONDS);
        broadcastRoomState(room);
        snapshot(room, name);
    }

    public void kickParticipant(Room room, String targetName) {
        if (room == null || targetName == null) return;

        revokeParticipantIdentity(room, targetName);
        String json;
        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("type", "kicked");
            payload.put("redirect", "/");
            json = objectMapper.writeValueAsString(payload);
        } catch (JacksonException e) {
            json = "{\"type\":\"kicked\",\"redirect\":\"/\"}";
        }

        List<WebSocketSession> targetSessions = new ArrayList<>();
        for (Map.Entry<WebSocketSession, Room> e : sessionToRoomMap.entrySet()) {
            if (room.equals(e.getValue())) {
                WebSocketSession s = e.getKey();
                String name = sessionToParticipantMap.get(s);
                if (targetName.equals(name)) targetSessions.add(s);
            }
        }
        for (WebSocketSession s : targetSessions) {
            try { sendText(s, json); } catch (IOException ignored) {}
            sessionToRoomMap.remove(s);
            sessionToParticipantMap.remove(s);
            closeSocket(s, new CloseStatus(4001, "Kicked"));
        }

        cancelPresenceTimers(room, targetName);
        room.removeParticipant(targetName);

        String newHost = room.assignNewHostIfNecessary(targetName);
        if (newHost != null) broadcastHostChange(room, targetName, newHost);

        broadcastRoomState(room);
        snapshot(room, targetName);
    }

    public void closeRoom(String roomCode) {
        Room room = getRoom(roomCode);
        closeRoom(room);
    }

    public void closeRoom(Room room) {
        if (room == null) return;
        room.identities().close();
        clientToName.keySet().removeIf(key -> key.startsWith(mapKey(room.getCode(), "")));

        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("type", "roomClosed");
            payload.put("redirect", "/");
            String json = objectMapper.writeValueAsString(payload);
            broadcastToRoom(room, json);
        } catch (JacksonException e) {
            e.printStackTrace();
        }

        List<WebSocketSession> toClose = new ArrayList<>();
        for (Map.Entry<WebSocketSession, Room> e : sessionToRoomMap.entrySet()) {
            if (room.equals(e.getValue())) toClose.add(e.getKey());
        }
        for (WebSocketSession s : toClose) {
            closeSocket(s, new CloseStatus(4000, "Room closed"));
            sessionToRoomMap.remove(s);
            sessionToParticipantMap.remove(s);
        }

        for (Participant p : new ArrayList<>(room.getParticipants())) cancelPresenceTimers(room, p.getName());
        rooms.remove(room.getCode(), room);
        roomSpecialsSelected.remove(room.getCode()); // cleanup selection
    }

    // ========================================================================
    //  IDENTITY PING
    // ========================================================================

    public void sendIdentity(WebSocketSession session, String yourName, String cid) {
        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("type", "you");
            payload.put("yourName", yourName);
            if (cid != null) payload.put("cid", cid);
            String json = objectMapper.writeValueAsString(payload);
            sendText(session, json);
        } catch (IOException | JacksonException e) {
            e.printStackTrace();
        }
    }

    // ========================================================================
    //  TOPIC PARSING
    // ========================================================================

    private static final Pattern JIRA_KEY = Pattern.compile("\\b([A-Z][A-Z0-9]+-\\d+)\\b");

    private static String[] parseTopic(String input) {
        if (input == null) return new String[]{null, null};
        String s = input.trim();
        if (s.isEmpty()) return new String[]{null, null};

        boolean isUrl = s.startsWith("http://") || s.startsWith("https://");
        String url = isUrl ? s : null;

        String label;
        Matcher m = JIRA_KEY.matcher(s);
        if (m.find()) label = m.group(1);
        else label = s.length() > 140 ? s.substring(0, 140) + "…" : s;

        return new String[]{label, url};
    }

    // ========================================================================
    //  MISC HELPERS
    // ========================================================================

    private static String sanitizeSequenceId(String id) {
        if (id == null) return "fib.scrum";
        String s = id.trim().toLowerCase(Locale.ROOT);
        if (s.equals("fib-scrum")) s = "fib.scrum";
        if (s.equals("fib-enh"))   s = "fib.enh";
        if (s.equals("fib-math"))  s = "fib.math";
        if (s.equals("t-shirt"))   s = "tshirt";
        switch (s) {
            case "fib.scrum":
            case "fib.enh":
            case "fib.math":
            case "pow2":
            case "tshirt":
                return s;
            default:
                return "fib.scrum";
        }
    }

    // At least this many numeric voters required before returning tied outliers
    private static final int MIN_VOTERS_FOR_TIED_OUTLIERS = 5;

    /**
     * Names farthest from the average (numeric votes only, ≥3 voters required).
     * - If there is a single clear farthest voter → return that one.
     * - If several voters are tied for farthest → only return them when there are ≥ MIN_VOTERS_FOR_TIED_OUTLIERS
     *   numeric voters; otherwise return an empty list (no outliers).
     */
    public List<String> farthestFromAverageNames(Room room) {
        Map<String, Double> nv = collectNumericVotes(room);
        int n = nv.size();
        if (n < 3) return List.of();

        OptionalDouble avgOpt = nv.values().stream().mapToDouble(Double::doubleValue).average();
        if (avgOpt.isEmpty()) return List.of();
        double avg = avgOpt.getAsDouble();

        double maxDist = -1d;
        Map<String, Double> dist = new LinkedHashMap<>();
        for (Map.Entry<String, Double> e : nv.entrySet()) {
            double d = Math.abs(e.getValue() - avg);
            dist.put(e.getKey(), d);
            if (d > maxDist) maxDist = d;
        }
        if (maxDist <= 0) return List.of(); // all equal → no outliers

        final double eps = 1e-9;
        List<String> tied = new ArrayList<>();
        for (Map.Entry<String, Double> e : dist.entrySet()) {
            if (Math.abs(e.getValue() - maxDist) <= eps) tied.add(e.getKey());
        }

        if (tied.size() == 1) return tied;                     // exactly one outlier
        return (n >= MIN_VOTERS_FOR_TIED_OUTLIERS) ? tied : List.of(); // multiple: require n >= 5
    }
}
