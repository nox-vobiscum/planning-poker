package com.example.planningpoker.controller;

import com.example.planningpoker.model.Participant;
import com.example.planningpoker.persistence.PersistentRooms;
import com.example.planningpoker.rooms.web.NameAvailabilityController;
import com.example.planningpoker.service.GameService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.ui.ExtendedModelMap;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class RoomNameCheckControllerTest {
    private final GameService service = new GameService();
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(
            new RoomNameCheckController(service), new NameAvailabilityController(service)).build();

    private void check(String code, String name, boolean available, String suggestion) throws Exception {
        mvc.perform(get("/api/rooms/{code}/name-taken", code).param("name", name))
                .andExpect(status().isOk()).andExpect(content().string(String.valueOf(!available)));
        mvc.perform(get("/api/rooms/{code}/name-available", code).param("name", name))
                .andExpect(status().isOk()).andExpect(jsonPath("$.available").value(available))
                .andExpect(jsonPath("$.suggestion").value(suggestion));
    }

    @Test void readsDoNotCreateRoomsOrReserveNames() throws Exception {
        check("absent", " Alice ", true, "Alice");
        assertNull(service.getRoom("absent"));
        var room = service.getOrCreateRoom("live");
        check("live", "Alice", true, "Alice");
        assertTrue(room.reserveName("Alice", "socket"));
    }

    @Test void liveActiveInactiveAndPendingNamesUseTheSameTrimmedCaseSensitiveRules() throws Exception {
        var room = service.getOrCreateRoom("live");
        var alice = new Participant("Alice");
        room.addParticipant(alice);
        check(" live ", " Alice ", false, "Alice (2)");
        alice.setActive(false);
        check("live", "Alice", false, "Alice (2)");
        check("live", "alice", true, "alice");
        assertTrue(room.reserveName("Alice (2)", "pending"));
        check("live", "Alice", false, "Alice (3)");
        check("live", "Alice (2)", false, "Alice (3)");
        room.releaseName("Alice (2)", "wrong-socket");
        check("live", "Alice (2)", false, "Alice (3)");
        room.releaseName("Alice (2)", "pending");
        check("live", "Alice (2)", true, "Alice (2)");
    }

    @Test void releasedLiveNamesAreFreeWithoutWaitingForASnapshot() throws Exception {
        var room = service.getOrCreateRoom("live");
        room.addParticipant(new Participant("Alice"));
        check("live", "Alice", false, "Alice (2)");
        room.removeParticipant("Alice");
        check("live", "Alice", true, "Alice");
        check("other", "Alice", true, "Alice");
    }

    @Test void legacyPreflightRendersWithoutAdmittingOrRejectingAnIdentity() {
        var room = service.getOrCreateRoom("live");
        room.addParticipant(new Participant("Alice"));
        var controller = new GameController(mock(PersistentRooms.class), service);
        var model = new ExtendedModelMap();
        assertEquals("room", controller.getRoom("live", "Alice", "1", model));
        assertEquals("Alice", model.get("participantName"));
        assertEquals(1, room.getParticipants().size());
        assertEquals("room", controller.getRoom("not-created", "Alice", "1", new ExtendedModelMap()));
        assertNull(service.getRoom("not-created"));
        assertEquals("invite", controller.getRoom("live", "", "1", new ExtendedModelMap()));
    }

    @Test void postKeepsRequiredValidationAndDoesNotAddNameOnlyPreflight() {
        var controller = new GameController(mock(PersistentRooms.class), service);
        assertEquals("index", controller.joinRoom(" ", "live", false, false, new ExtendedModelMap()));
        String redirect = controller.joinRoom(" Alice ", " live ", false, false, new ExtendedModelMap());
        assertEquals("redirect:/room?roomCode=live&participantName=Alice", redirect);
        assertNull(service.getRoom("live"));
    }
}