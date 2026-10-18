package com.example.planningpoker.controller;

import com.example.planningpoker.model.Room;
import com.example.planningpoker.service.GameService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/signal")
public class SignalController {

    private final GameService gameService;

    public SignalController(GameService gameService) {
        this.gameService = gameService;
    }

    /**
     * Lightweight beacon endpoint to mark a client as "left intentionally".
     * Called via navigator.sendBeacon() on pagehide/beforeunload.
     */
    @PostMapping("/bye")
    public ResponseEntity<Void> bye(
            @RequestParam("roomCode") String roomCode,
            @RequestParam("cid") String cid
    ) {
        // CID-only beacons are no longer an authenticated lifecycle operation.
        return ResponseEntity.status(410).build();

    }
}
