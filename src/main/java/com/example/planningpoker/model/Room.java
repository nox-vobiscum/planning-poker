package com.example.planningpoker.model;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Room model: participants, sequence/deck, topic, specials, and reveal/host state.
 * GameService synchronizes on Room instances, so this class itself does not add extra locking.
 */
public class Room {

    // ---------------------------------------------------------------------
    // Core identity
    // ---------------------------------------------------------------------

    private final String code;
    private final com.example.planningpoker.service.RoomIdentityRegistry identities;

    public com.example.planningpoker.service.RoomIdentityRegistry identities() { return identities; }

    /** Participants by canonical name (insertion order preserved to keep a stable roster order). */
    private final Map<String, Participant> participants = new LinkedHashMap<>();

    /** cid (client-id per tab) → participant name. */
    private final Map<String, String> cidToName = new ConcurrentHashMap<>();

    // ---------------------------------------------------------------------
    // Estimation state
    // ---------------------------------------------------------------------

    /** Sequence identifier (normalized by CardSequences). */
    private String sequenceId = CardSequences.DEFAULT_SEQUENCE_ID;

    /** Whether votes are currently revealed. */
    private boolean cardsRevealed = false;

    /** Auto-reveal toggle. */
    private boolean autoRevealEnabled = false;

    // ---------------------------------------------------------------------
    // Specials toggles (server-wide selection lives in GameService; room keeps the allow flag)
    // ---------------------------------------------------------------------

    /** Legacy flag: whether any specials are allowed (question card might still be rendered by clients). */
    private boolean allowSpecials = false;

    // ---------------------------------------------------------------------
    // Topic
    // ---------------------------------------------------------------------

    private String topicLabel;
    private String topicUrl;
    private boolean topicVisible = false;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    public Room(String code) { this(code, System::nanoTime); }

    public Room(String code, java.util.function.LongSupplier identityClock) {
        identities = new com.example.planningpoker.service.RoomIdentityRegistry(
                this, identityClock, com.example.planningpoker.service.RoomIdentityRegistry.DEFAULT_LEASE);
        this.code = (code == null || code.isBlank()) ? "demo" : code.trim();
    }

    // ---------------------------------------------------------------------
    // Basic accessors
    // ---------------------------------------------------------------------

    public String getCode() {
        return code;
    }

    public String getSequenceId() {
        return sequenceId;
    }

    public void setSequenceId(String sequenceId) {
        this.sequenceId = CardSequences.normalizeSequenceId(sequenceId);
    }

    public boolean areVotesRevealed() {
        return cardsRevealed;
    }

    public void setCardsRevealed(boolean revealed) {
        this.cardsRevealed = revealed;
    }

    public boolean isAutoRevealEnabled() {
        return autoRevealEnabled;
    }

    public void setAutoRevealEnabled(boolean autoRevealEnabled) {
        this.autoRevealEnabled = autoRevealEnabled;
    }

    public boolean isAllowSpecials() {
        return allowSpecials;
    }

    public void setAllowSpecials(boolean allowSpecials) {
        this.allowSpecials = allowSpecials;
    }

    public String getTopicLabel() {
        return topicLabel;
    }

    public void setTopicLabel(String topicLabel) {
        this.topicLabel = (topicLabel == null || topicLabel.isBlank()) ? null : topicLabel.trim();
    }

    public String getTopicUrl() {
        return topicUrl;
    }

    public void setTopicUrl(String topicUrl) {
        this.topicUrl = (topicUrl == null || topicUrl.isBlank()) ? null : topicUrl.trim();
    }

    public boolean isTopicVisible() {
        return topicVisible;
    }

    public void setTopicVisible(boolean topicVisible) {
        this.topicVisible = topicVisible;
    }

    // ---------------------------------------------------------------------
    // Participants API (used by GameService/GameWebSocketHandler)
    // ---------------------------------------------------------------------

    /** Returns a snapshot list of participants, preserving insertion order. */
    public List<Participant> getParticipants() {
        return new ArrayList<>(participants.values());
    }

    /** Convenience: names snapshot; used as a reflection fallback in the handler. */
    public Collection<String> getParticipantNames() {
        return new ArrayList<>(participants.keySet());
    }

    /** Optional active participants accessor (reflection-friendly fallback). */
    public Collection<Participant> getActiveParticipants() {
        List<Participant> out = new ArrayList<>();
        for (Participant p : participants.values()) {
            if (p != null && p.isActive()) out.add(p);
        }
        return out;
    }

    public Participant getParticipant(String name) {
        if (name == null) return null;
        return participants.get(name);
    }

    public Optional<Participant> getParticipantByCid(String cid) {
        if (cid == null) return Optional.empty();
        String name = cidToName.get(cid);
        return (name == null) ? Optional.empty() : Optional.ofNullable(participants.get(name));
    }

    public void addParticipant(Participant p) {
        if (p == null || p.getName() == null || p.getName().isBlank()) return;
        participants.put(p.getName(), p);
    }

    public void removeParticipant(String name) {
        if (name == null) return;
        participants.remove(name);
        // purge cid links pointing to this name
        Iterator<Map.Entry<String, String>> it = cidToName.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, String> e = it.next();
            if (name.equals(e.getValue())) it.remove();
        }
    }

    /** Link/overwrite a cid to the given participant name. */
    public void linkCid(String cid, String name) {
        if (cid == null || name == null) return;
        cidToName.put(cid, name);
    }

    /** Current host, if any. */
    public Participant getHost() {
        for (Participant p : participants.values()) {
            if (p != null && p.isHost()) return p;
        }
        return null;
    }

    /**
     * Assign a new host if none exists or the previous host left.
     * Returns the new host name or null if none can be assigned.
     */
    public String assignNewHostIfNecessary(String previousHostName) {
        Participant current = getHost();
        if (current != null) return null; // host already present

        // Priority: active & participating → active → any
        Participant candidate = null;

        // pass 1: active + participating
        for (Participant p : participants.values()) {
            if (p == null) continue;
            if (p.isActive() && p.isParticipating() && !Objects.equals(p.getName(), previousHostName)) {
                candidate = p;
                break;
            }
        }
        // pass 2: active (any)
        if (candidate == null) {
            for (Participant p : participants.values()) {
                if (p == null) continue;
                if (p.isActive() && !Objects.equals(p.getName(), previousHostName)) {
                    candidate = p;
                    break;
                }
            }
        }
        // pass 3: any participant
        if (candidate == null) {
            for (Participant p : participants.values()) {
                if (p == null) continue;
                if (!Objects.equals(p.getName(), previousHostName)) {
                    candidate = p;
                    break;
                }
            }
        }

        if (candidate != null) {
            candidate.setHost(true);
            return candidate.getName();
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Deck helpers
    // ---------------------------------------------------------------------

    /**
     * Returns the current deck (sequence + global specials).
     * GameService will filter specials according to per-room selection.
     */
    public List<String> getCurrentCards() {
        return CardSequences.buildDeck(sequenceId);
    }

    // ---------------------------------------------------------------------
    // Room-level actions
    // ---------------------------------------------------------------------

    /** Clears all votes and hides cards (keeps participants and host). */
    public void reset() {
        for (Participant p : participants.values()) {
            if (p == null) continue;
            p.setVote(null);
            // Do not change participating/active/host flags here.
        }
        setCardsRevealed(false);
    }

    // ---------------------------------------------------------------------
    // Back-compat helpers for controllers/tests
    // ---------------------------------------------------------------------

    /** Returns true if a participant with the given name exists (case-sensitive). */
    public boolean nameInUse(String raw) {
        if (raw == null) return false;
        String name = raw.trim();
        if (name.isEmpty()) return false;
        return getParticipant(name) != null;
    }

    /**
     * Ensures a unique participant name within this room.
     * - null/empty -> "Guest"
     * - Dedupes as "Name (2)", "Name (3)", ...
     */
    public String ensureUniqueName(String requested) {
        String base = (requested == null || requested.trim().isEmpty()) ? "Guest" : requested.trim();
        String candidate = base;
        int suffix = 2;
        while (true) {
            Participant clash = getParticipant(candidate);
            if (clash == null) return candidate;
            candidate = base + " (" + suffix + ")";
            suffix++;
        }
    }

    /**
     * Rename an existing participant. Returns the final unique name.
     * If "from" does not exist, it creates the "to" (unique) entry if missing.
     * NOTE: This is a back-compat shim; orchestration (CID mapping, broadcasts, snapshots)
     *       is handled in GameService.
     */
    public String renameParticipant(String from, String to) {
        if (Objects.equals(from, to)) return (to == null ? null : to);

        String desired = (to == null ? "" : to.trim());
        if (desired.isEmpty()) desired = "Guest";
        String finalName = ensureUniqueName(desired);

        Participant cur = getParticipant(from);
        if (cur == null) {
            // No existing "from": ensure target exists
            if (getParticipant(finalName) == null) {
                Participant p = new Participant(finalName);
                addParticipant(p);
            }
            // Update any cids pointing to "from" (defensive)
            if (from != null) {
                for (Map.Entry<String, String> e : cidToName.entrySet()) {
                    if (from.equals(e.getValue())) e.setValue(finalName);
                }
            }
            return finalName;
        }

        if (from.equals(finalName)) return finalName;

        // Copy state to a new participant with the final name
        Participant repl = new Participant(finalName);
        repl.setActive(cur.isActive());
        repl.setParticipating(cur.isParticipating());
        repl.setHost(cur.isHost());
        repl.setVote(cur.getVote());

        addParticipant(repl);

        // Reassign cids that pointed to the old name before removing the old participant.
        // removeParticipant() also purges matching cid entries, so the order matters here.
        for (Map.Entry<String, String> e : cidToName.entrySet()) {
            if (from.equals(e.getValue())) e.setValue(finalName);
        }

        removeParticipant(from);
        return finalName;
    }
}
