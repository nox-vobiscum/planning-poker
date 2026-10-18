package com.example.planningpoker.rooms.web;

import com.example.planningpoker.service.GameService;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/rooms")
public class NameAvailabilityController {
    private final GameService service;

    public NameAvailabilityController(GameService service) {
        this.service = service;
    }

    @GetMapping("/{code}/name-available")
    public Map<String, Object> nameAvailable(@PathVariable String code, @RequestParam String name) {
        var result = service.nameAvailability(code, name);
        return Map.of("available", result.available(), "suggestion", result.suggestion());
    }
}