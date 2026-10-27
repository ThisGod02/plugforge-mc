package dev.plugforge.menudemo;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;
import org.mockbukkit.mockbukkit.entity.PlayerMock;

/** L1 cannot see the click bug of live-menu-bug: these pass for both fixtures. */
class MenuDemoTest {

    private ServerMock server;

    @BeforeEach
    void setUp() {
        server = MockBukkit.mock();
        MockBukkit.load(MenuDemoPlugin.class);
    }

    @AfterEach
    void tearDown() {
        MockBukkit.unmock();
    }

    @Test
    void menuOpensNineSlotInventory() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("menu");
        assertEquals(9, steve.getOpenInventory().getTopInventory().getSize());
    }

    @Test
    void claimsStartAtZero() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("claims");
        assertEquals("Получено: 0", steve.nextMessage());
    }
}
