FILE: src/test/java/dev/plugforge/greeter/GreeterAcceptanceTest.java
```java
package dev.plugforge.greeter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;
import org.mockbukkit.mockbukkit.entity.PlayerMock;

/** Acceptance tests for examples/greeter/spec.json; one test per criterion. */
class GreeterAcceptanceTest {

    private ServerMock server;
    private GreeterPlugin plugin;

    @BeforeEach
    void setUp() {
        server = MockBukkit.mock();
        plugin = MockBukkit.load(GreeterPlugin.class);
    }

    @AfterEach
    void tearDown() {
        MockBukkit.unmock();
    }

    @Test
    void ac1DefaultConfigHasGreeting() {
        assertEquals("Hello, %player%!", plugin.getConfig().getString("greeting.message"));
    }

    @Test
    void ac2GreetGreetsSender() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("greet");
        assertEquals("Hello, Steve!", steve.nextMessage());
        assertNull(steve.nextMessage());
    }

    @Test
    void ac3GreetOtherPlayer() {
        PlayerMock steve = server.addPlayer("Steve");
        PlayerMock alex = server.addPlayer("Alex");
        steve.performCommand("greet Alex");
        assertEquals("Hello, Alex!", alex.nextMessage());
        assertEquals("Greeted Alex.", steve.nextMessage());
    }

    @Test
    void ac4GreetUnknownPlayer() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("greet Nobody");
        assertEquals("Player not found: Nobody", steve.nextMessage());
    }

}
```
