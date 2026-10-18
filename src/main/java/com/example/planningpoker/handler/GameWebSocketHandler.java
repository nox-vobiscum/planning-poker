package com.example.planningpoker.handler;

import com.example.planningpoker.model.Participant;
import com.example.planningpoker.model.Room;
import com.example.planningpoker.service.GameService;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.lang.reflect.Method;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket handler for /gameSocket.
 * - Accepts only sessions bound by IdentityWebSocketHandler; legacy admission is disabled.
 * - Handles rename:<name>, votes, host actions, toggles
 * - Heartbeat: replies "pong" to client pings (keeps client watchdog happy)
 * - On unexpected close: schedules grace disconnect (GameService decides timing)
 * - Sends initial state snapshot (best-effort, via reflection)
 * - After join, replays the current roster to the just-joined session
 *
 * Specials:
 * - "specials:<on|off>" toggles extras (question mark is client-side always present)
 * - "specials:<json|csv>" sets extras by emojis OR by ids (server maps ids → emojis)
 * - "specials:set:<id,id,...>" sets extras by ids (host-only; ids are mapped → emojis)
 *
 * Sequence (host-only):
 * - accepts "sequence:", "seq:" and "setSequence:"
 */
@Component
public class GameWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(GameWebSocketHandler.class);

    private final GameService gameService;

    /** Per WebSocket session → (room, cid, canonicalName) */
    private final Map<String, Conn> bySession = new ConcurrentHashMap<>();

    /** Host hard demotion safeguard window (should match service). */
    private static final long HOST_INACTIVE_MS = 3_600_000L;

    /** Known specials palette ids → emojis (kept in sync with frontend). */
    private static final Map<String, String> ID_TO_EMOJI = Map.of(
            "coffee", "☕",
            "speech", "💬",
            "telescope", "🔭",
            "waiting", "⏳",
            "dependency", "🔗",
            "risk", "⚠️",
            "relevance", "🎯"
    );
    private static final Set<String> SPECIAL_IDS = ID_TO_EMOJI.keySet();

    private static boolean parseOn(String s) {
        if (s == null) return false;
        switch (s.trim().toLowerCase(Locale.ROOT)) {
            case "1": case "true": case "on": case "yes": case "y":  return true;
            case "0": case "false": case "off": case "no": case "n": return false;
            default: return Boolean.parseBoolean(s);
        }
    }

    public GameWebSocketHandler(GameService gameService) {
        this.gameService = gameService;
    }

    /** Legacy CID admission is disabled; the identity gateway is the only public entry. */
    @Override
    public void afterConnectionEstablished(@NonNull WebSocketSession session) throws Exception {
        session.close(new CloseStatus(4406, "Reload required"));
    }

    void bindAuthenticated(WebSocketSession session, Room room, String participantId, String name) {
        gameService.addSession(session, room);
        gameService.trackParticipant(session, name);
        bySession.put(session.getId(), new Conn(room.getCode(), participantId, name));
        gameService.sendIdentity(session, name, null);
        gameService.sendRoomState(session, room);
    }

    void forgetAuthenticated(WebSocketSession session) {
        bySession.remove(session.getId());
        gameService.removeSession(session);
    }
    @Override
    protected void handleTextMessage(@NonNull WebSocketSession session,
                                     @NonNull TextMessage message) throws Exception {
        Conn c = bySession.get(session.getId());
        if (c == null) {
            log.warn("WS message from unauthenticated session sid={}", session.getId());
            return;
        }

        final String roomCode = c.room;
        final String cid      = c.cid;
        final String payload  = message.getPayload();

        try {
            // Heartbeat
            if ("ping".equals(payload)) {
                try { gameService.touch(roomCode, cid); } catch (Throwable ignore) {}
                try { gameService.sendText(session, "pong"); }
                catch (Exception e) { log.warn("WS pong send failed (room={}, name={}, cid={}): {}", roomCode, c.name, cid, e.toString()); }
                return;
            }

            // Explicit sync request
            if ("requestSync".equals(payload)) {
                Room room = gameService.getRoom(roomCode);
                if (room != null) {
                    if (!tryInvoke(gameService, "sendRoomState",
                            new Class<?>[]{WebSocketSession.class, Room.class},
                            new Object[]{session, room})) {
                        gameService.broadcastRoomState(room);
                    }
                }
                return;
            }

            // Rename: "rename:<urlEncodedName>"
            if (payload.startsWith("rename:")) {
                String requested = decode(payload.substring("rename:".length()));
                String finalName = gameService.renameParticipant(roomCode, cid, requested);
                if (finalName == null || finalName.isBlank()) return;

                bySession.put(session.getId(), new Conn(roomCode, cid, finalName));
                gameService.trackParticipant(session, finalName);
                gameService.sendIdentity(session, finalName, null);
                return;
            }

            // Vote: "vote:<ignoredName>:<value>"
            if (payload.startsWith("vote:")) {
                String[] parts = payload.split(":", 3);
                if (parts.length >= 3) gameService.setVote(roomCode, cid, parts[2]);
                return;
            }

            // Sequence: "sequence:", "setSequence:", "seq:" (host-only)
            if (payload.startsWith("sequence:") || payload.startsWith("setSequence:") || payload.startsWith("seq:")) {
                if (!isHost(roomCode, c.name)) return;
                int idx = payload.indexOf(':');
                String seq = decode(payload.substring(idx + 1));
                gameService.setSequence(roomCode, seq);
                return;
            }

            // Topic save / toggle (host-only)
            if (payload.startsWith("topicSave:")) {
                if (!isHost(roomCode, c.name)) return;
                String text = payload.substring("topicSave:".length());
                gameService.saveTopic(roomCode, decode(text));
                return;
            }
            if (payload.startsWith("topicVisible:")) {
                if (!isHost(roomCode, c.name)) return;
                boolean on = Boolean.parseBoolean(payload.substring("topicVisible:".length()));
                gameService.setTopicEnabled(roomCode, on);
                return;
            }

            // Participation toggle (self)
            if (payload.startsWith("participation:")) {
                boolean estimating = Boolean.parseBoolean(payload.substring("participation:".length()));
                gameService.setSpectator(roomCode, cid, !estimating);
                return;
            }

            // Auto-reveal toggle (host-only)
            if (payload.startsWith("autoReveal:")) {
                if (!isHost(roomCode, c.name)) return;
                boolean on = Boolean.parseBoolean(payload.substring("autoReveal:".length()));
                gameService.setAutoRevealEnabled(roomCode, on);
                if (on && gameService.shouldAutoReveal(roomCode)) gameService.reveal(roomCode);
                return;
            }

            // Specials (host-only)
            // 1) Explicit ids path: "specials:set:<id,id,...>"
            if (payload.startsWith("specials:set:")) {
                if (!isHost(roomCode, c.name)) return;
                String tail = decode(payload.substring("specials:set:".length()));
                List<String> ids = splitCsv(tail);
                List<String> emojis = mapIdsToEmojis(ids);
                gameService.setSpecialsSelected(roomCode, emojis);
                return;
            }

            // 2) Flex path: "specials:<json|csv|on|off>"
            if (payload.startsWith("specials:")) {
                if (!isHost(roomCode, c.name)) return;
                String tail = payload.substring("specials:".length()).trim();

                // Try JSON array first (either ids or emojis)
                try {
                    String decoded = decode(tail);
                    if (decoded.startsWith("[") && decoded.endsWith("]")) {
                        List<String> arr = new JsonMapper().readValue(decoded, new TypeReference<List<String>>() {});
                        if (arr != null && !arr.isEmpty()) {
                            List<String> emojis = looksLikeIds(arr) ? mapIdsToEmojis(arr) : new ArrayList<>(arr);
                            gameService.setSpecialsSelected(roomCode, emojis);
                            return;
                        }
                    }
                } catch (Exception ignore) { /* fall through */ }

                // Try CSV (either ids or emojis)
                try {
                    String decoded = decode(tail);
                    if (decoded.contains(",")) {
                        List<String> parts = splitCsv(decoded);
                        List<String> emojis = looksLikeIds(parts) ? mapIdsToEmojis(parts) : parts;
                        gameService.setSpecialsSelected(roomCode, emojis);
                        return;
                    }
                } catch (Exception ignore) { /* fall through */ }

                // Boolean fallback (on/off)
                boolean on = parseOn(tail);
                gameService.setAllowSpecials(roomCode, on);
                return;
            }

            // Host / Kick (host-only)
            if (payload.startsWith("makeHost:")) {
                if (!isHost(roomCode, c.name)) return;
                String target = decode(payload.substring("makeHost:".length()));
                if (!target.equals(c.name)) gameService.makeHost(roomCode, target);
                return;
            }
            if (payload.startsWith("kick:")) {
                if (!isHost(roomCode, c.name)) return;
                String target = decode(payload.substring("kick:".length()));
                Room room = gameService.getRoom(roomCode);
                if (room != null && !target.equals(c.name) && room.getParticipant(target) != null
                        && !room.getParticipant(target).isHost()) gameService.kickParticipant(room, target);
                return;
            }

            // NEW: Host sets a target participant's participation/spectator state
            // Accept both forms:
            //   "setParticipating:<name>:<true|false>"  (true = estimating)
            //   "setSpectator:<name>:<true|false>"      (true = spectator)
            if (payload.startsWith("setParticipating:") || payload.startsWith("setSpectator:")) {
                if (!isHost(roomCode, c.name)) return;

                final boolean byParticipating = payload.startsWith("setParticipating:");
                final String rest = payload.substring(payload.indexOf(':') + 1);
                String targetRaw;
                boolean flag;

                String[] parts = rest.split(":", 2);
                targetRaw = decode(parts[0]);
                flag = (parts.length >= 2) && Boolean.parseBoolean(parts[1]);

                String target = resolveTargetName(roomCode, targetRaw);

                log.info("WS CMD {} by={} targetRaw='{}' -> resolved='{}' flag={}",
                        (byParticipating ? "setParticipating" : "setSpectator"),
                        c.name, targetRaw, target, flag);

                if (target == null || target.isBlank() || target.equals(c.name)) return;
                Room targetRoom = gameService.getRoom(roomCode);
                Participant targetParticipant = targetRoom == null ? null : targetRoom.getParticipant(target);
                if (targetParticipant == null || targetParticipant.isHost()) return;

                if (byParticipating) {
                    gameService.setParticipatingFor(roomCode, target, flag);
                } else {
                    gameService.setSpectator(roomCode, target, flag);
                }
                return;
            }

            // Keywords
            switch (payload) {
                case "revealCards" -> { if (isHost(roomCode, c.name)) gameService.reveal(roomCode); }
                case "resetRoom"   -> { if (isHost(roomCode, c.name)) gameService.reset(roomCode); }

                case "intentionalLeave" -> {
                    gameService.exitParticipant(gameService.getRoom(roomCode), c.name);
                    return;
                }

                case "topicClear" -> {
                    if (!isHost(roomCode, c.name)) return;
                    gameService.clearTopic(roomCode);
                    return;
                }

                case "closeRoom" -> {
                    Room room = gameService.getRoom(roomCode);
                    if (room != null) {
                        Participant host = room.getHost();
                        boolean isHost = (host != null && Objects.equals(host.getName(), c.name));
                        if (isHost) gameService.closeRoom(room);
                        else log.warn("closeRoom ignored: {} is not host of {}", c.name, roomCode);
                    }
                    return;
                }

                default -> log.debug("Ignored unsupported command");
            }
        } catch (Throwable t) {
            log.error("WS command failed (room={}, name={})", roomCode, c.name);
            gameService.closeSocket(session, CloseStatus.SERVER_ERROR);
            throw t;
        }
    }

    @Override
    public void handleTransportError(@NonNull WebSocketSession session, @NonNull Throwable exception) {
        log.error("WS ERROR sid={} uri={} : transport error", session.getId(), safeUri(session), exception);
    }

    @Override
    public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) {
        forgetAuthenticated(session);
    }
    /* ---------------- helpers ---------------- */

    private static Map<String, String> parseQuery(URI uri) {
        Map<String, String> map = new ConcurrentHashMap<>();
        if (uri == null || uri.getQuery() == null) return map;
        for (String kv : uri.getQuery().split("&")) {
            int i = kv.indexOf('=');
            if (i > 0) {
                String k = URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8);
                String v = URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8);
                map.put(k, v);
            }
        }
        return map;
    }

    private static String decode(String s) {
        try { return URLDecoder.decode(s, StandardCharsets.UTF_8); }
        catch (Exception e) { return s; }
    }

    private String safeUri(WebSocketSession session) {
        try { return session.getUri().getPath(); } catch (Exception e) { return "n/a"; }
    }

    /** Check if caller is current host (by name). */
    private boolean isHost(String roomCode, String name) {
        Room room = gameService.getRoom(roomCode);
        if (room == null) return false;
        Participant host = room.getHost();
        return host != null && Objects.equals(host.getName(), name);
    }

    /** Resolve a target name robustly (exact, case-insensitive, or fallback to raw). */
    private String resolveTargetName(String roomCode, String raw) {
        if (raw == null) return null;
        Room room = gameService.getRoom(roomCode);
        if (room == null) return raw;
        String s = raw.trim();
        if (s.isEmpty()) return null;

        Participant exact = room.getParticipant(s);
        if (exact != null) return exact.getName();

        for (Participant p : room.getParticipants()) {
            if (p != null && p.getName() != null && p.getName().equalsIgnoreCase(s)) {
                return p.getName();
            }
        }
        return s;
    }

    /** Best-effort: send state snapshot to just-joined session via whatever method exists. */
    private void sendInitialStateSnapshot(WebSocketSession session, Room room, String roomCode) {
        if (tryInvoke(gameService, "sendRoomState", new Class<?>[]{WebSocketSession.class, Room.class}, new Object[]{session, room})) return;
        if (tryInvoke(gameService, "sendRoomState", new Class<?>[]{Room.class, WebSocketSession.class}, new Object[]{room, session})) return;
        if (tryInvoke(gameService, "sendRoomSnapshot", new Class<?>[]{WebSocketSession.class, Room.class}, new Object[]{session, room})) return;
        if (tryInvoke(gameService, "sendRoomSnapshot", new Class<?>[]{Room.class, WebSocketSession.class}, new Object[]{room, session})) return;
        if (tryInvoke(gameService, "sendStateTo", new Class<?>[]{WebSocketSession.class, Room.class}, new Object[]{session, room})) return;
        if (tryInvoke(gameService, "sendStateTo", new Class<?>[]{WebSocketSession.class, String.class}, new Object[]{session, roomCode})) return;

        // Fallback: broadcast room state (new session is registered and will receive it)
        if (tryInvoke(gameService, "broadcastRoom", new Class<?>[]{Room.class}, new Object[]{room})) return;
        if (tryInvoke(gameService, "broadcastRoomState", new Class<?>[]{Room.class}, new Object[]{room})) return;
        if (tryInvoke(gameService, "broadcast", new Class<?>[]{Room.class}, new Object[]{room})) return;

        log.debug("WS INIT snapshot: no suitable GameService method found; skipping explicit snapshot");
    }

    /**
     * Replay the current roster to a single session as "participantJoined:<name>" events.
     * This makes the just-joined client fully consistent even if it missed earlier join broadcasts.
     */
    private void replayRosterTo(WebSocketSession session, Room room, String receiverName) {
        List<String> names = extractActiveNames(room);
        names.removeIf(n -> n == null || n.isBlank() || Objects.equals(n, receiverName));
        if (names.isEmpty()) return;

        for (String name : names) {
            try {
                gameService.sendText(session, "participantJoined:" + name);
            } catch (Exception e) {
                log.warn("WS ROSTER send failed to {} for {}: {}", receiverName, name, e.toString());
            }
        }
        log.info("WS ROSTER replay to {} ({}): {}", receiverName, names.size(), names);
    }

    /** Extract active participant names from Room using reflection-friendly fallbacks. */
    private List<String> extractActiveNames(Room room) {
        // 1) Room#getParticipants(): Map<String, Participant> OR Collection<Participant>
        try {
            Method m = room.getClass().getMethod("getParticipants");
            Object res = m.invoke(room);
            if (res instanceof Map<?, ?> map) {
                List<String> out = new ArrayList<>();
                for (Object v : map.values()) {
                    String n = readNameIfActive(v);
                    if (n != null) out.add(n);
                }
                return out;
            }
            if (res instanceof Collection<?> col) {
                List<String> out = new ArrayList<>();
                for (Object v : col) {
                    String n = readNameIfActive(v);
                    if (n != null) out.add(n);
                }
                return out;
            }
        } catch (Throwable ignored) {}

        // 2) Room#getActiveParticipants(): Collection<Participant>
        try {
            Method m = room.getClass().getMethod("getActiveParticipants");
            Object res = m.invoke(room);
            if (res instanceof Collection<?> col) {
                List<String> out = new ArrayList<>();
                for (Object v : col) {
                    String n = readNameIfActive(v);
                    if (n != null) out.add(n);
                }
                return out;
            }
        } catch (Throwable ignored) {}

        // 3) Room#getParticipantNames(): Collection<String>
        try {
            Method m = room.getClass().getMethod("getParticipantNames");
            Object res = m.invoke(room);
            if (res instanceof Collection<?> col) {
                List<String> out = new ArrayList<>();
                for (Object v : col) if (v != null) out.add(String.valueOf(v));
                return out;
            }
        } catch (Throwable ignored) {}

        // 4) Strong type fallback
        try {
            List<Participant> list = room.getParticipants();
            List<String> out = new ArrayList<>();
            for (Participant p : list) {
                if (p != null && p.isActive()) out.add(p.getName());
            }
            return out;
        } catch (Throwable ignored) {}

        return new ArrayList<>();
    }

    /** Returns name if object looks like an active Participant; otherwise null. */
    private String readNameIfActive(Object maybeParticipant) {
        if (maybeParticipant == null) return null;
        try {
            Method isActive = maybeParticipant.getClass().getMethod("isActive");
            Method getName  = maybeParticipant.getClass().getMethod("getName");
            Object active   = isActive.invoke(maybeParticipant);
            if (active instanceof Boolean b && b) {
                Object n = getName.invoke(maybeParticipant);
                return (n == null) ? null : String.valueOf(n);
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private boolean tryInvoke(Object target, String name, Class<?>[] sig, Object[] args) {
        try {
            Method m = target.getClass().getMethod(name, sig);
            m.setAccessible(true);
            m.invoke(target, args);
            log.debug("WS INIT snapshot via {}({}) ok",
                    name,
                    sig.length == 2 ? (sig[0].getSimpleName() + "," + sig[1].getSimpleName())
                                    : sig[0].getSimpleName());
            return true;
        } catch (NoSuchMethodException ignored) {
            return false;
        } catch (Throwable t) {
            log.warn("WS INIT snapshot: {} invocation failed: {}", name, t.toString());
            return false;
        }
    }

    /** Small immutable connection record. */
    private record Conn(String room, String cid, String name) {
        Conn {
            Objects.requireNonNull(room, "room");
            Objects.requireNonNull(cid, "cid");
            Objects.requireNonNull(name, "name");
        }
    }

    /* ---------- specials helpers ---------- */

    private static boolean looksLikeIds(List<String> list) {
        if (list == null || list.isEmpty()) return false;
        for (String s : list) {
            if (s == null) return false;
            String k = s.trim().toLowerCase(Locale.ROOT);
            if (!SPECIAL_IDS.contains(k)) return false;
        }
        return true;
    }

    private static List<String> splitCsv(String s) {
        if (s == null || s.isBlank()) return Collections.emptyList();
        String[] parts = s.split(",");
        List<String> out = new ArrayList<>(parts.length);
        for (String p : parts) {
            String v = (p == null ? "" : p.trim());
            if (!v.isEmpty()) out.add(v);
        }
        return out;
    }

    private static List<String> mapIdsToEmojis(List<String> ids) {
        if (ids == null || ids.isEmpty()) return Collections.emptyList();
        List<String> out = new ArrayList<>();
        for (String raw : ids) {
            if (raw == null) continue;
            String key = raw.trim().toLowerCase(Locale.ROOT);
            String emoji = ID_TO_EMOJI.get(key);
            if (emoji != null) out.add(emoji);
        }
        // keep stable order, remove duplicates
        LinkedHashSet<String> uniq = new LinkedHashSet<>(out);
        return new ArrayList<>(uniq);
    }

    /* --- local utilities for early redirect/close --- */

    private static String inviteUrl(String roomCode, String participantName, boolean taken) {
        String rc = URLEncoder.encode(roomCode == null ? "" : roomCode, StandardCharsets.UTF_8);
        String pn = URLEncoder.encode(participantName == null ? "" : participantName, StandardCharsets.UTF_8);
        String t  = taken ? "&nameTaken=1" : "";
        return "/invite?roomCode=" + rc + "&participantName=" + pn + t;
    }

    private static String jsonRedirect(String url) {
        String safeUrl = url.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"type\":\"kicked\",\"redirect\":\"" + safeUrl + "\"}";
    }

    private void sendRedirectAndClose(WebSocketSession session, String url, CloseStatus status) {
        try {
            String json = jsonRedirect(url);
            gameService.sendText(session, json);
        } catch (Exception ignored) { }
        try {
            session.close(status != null ? status : new CloseStatus(4005, "Rejected"));
        } catch (Exception ignored) { }
    }
}
