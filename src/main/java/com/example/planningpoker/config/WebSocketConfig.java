package com.example.planningpoker.config;

import com.example.planningpoker.handler.IdentityWebSocketHandler;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.jspecify.annotations.NonNull;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Registers the raw WebSocket endpoint under /gameSocket and enforces allowed origins.
 * - Uses origin *patterns* (works for exact values too) to avoid surprises.
 * - Logs the effective origins at startup so you can see immediately what is active in prod.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private static final Logger log = LoggerFactory.getLogger(WebSocketConfig.class);

    private final IdentityWebSocketHandler handler;
    private final List<String> allowedOrigins;

    public WebSocketConfig(
            IdentityWebSocketHandler handler,
            @Value("${app.websocket.allowed-origins:*}") String allowed
    ) {
        this.handler = handler;
        // Split by comma or whitespace, trim, drop empties
        this.allowedOrigins = Arrays.stream(allowed.split("[,\\s]+"))
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .collect(Collectors.toList());
    }

    @PostConstruct
    void logOrigins() {
        log.info("🔌 WebSocket allowed origins: {}", allowedOrigins);
        log.info("🔌 WebSocket endpoint mapped to: /gameSocket");
    }

    @Override
    public void registerWebSocketHandlers(@NonNull WebSocketHandlerRegistry registry) {
        String[] arr = allowedOrigins.toArray(new String[0]);
        // Use origin *patterns* — they accept exact values and wildcards.
        registry.addHandler(handler, "/gameSocket")
                .setAllowedOriginPatterns(arr);
    }
}
