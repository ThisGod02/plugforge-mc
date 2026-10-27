package dev.plugforge.hello;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;
import org.mockbukkit.mockbukkit.command.ConsoleCommandSenderMock;
import org.mockbukkit.mockbukkit.entity.PlayerMock;

/** Every idiom in packages/core/prompts/mockbukkit.md, proven against the pinned MockBukkit. */
class CheatSheetTest {

    private ServerMock server;
    private HelloPlugin plugin;

    @BeforeEach
    void setUp() {
        server = MockBukkit.mock();
        plugin = MockBukkit.load(HelloPlugin.class);
    }

    @AfterEach
    void tearDown() {
        MockBukkit.unmock();
    }

    @Test
    void playerCommandAndMessages() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("hello");
        assertEquals("Hello, Steve!", steve.nextMessage());
        assertNull(steve.nextMessage());
    }

    @Test
    void assertSaidAndNoMore() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.performCommand("hello");
        steve.assertSaid("Hello, Steve!");
        steve.assertNoMoreSaid();
    }

    @Test
    void consoleCommand() {
        ConsoleCommandSenderMock console = (ConsoleCommandSenderMock) server.getConsoleSender();
        server.dispatchCommand(console, "hello");
        assertEquals("Hello, CONSOLE!", console.nextMessage());
    }

    @Test
    void permissions() {
        PlayerMock steve = server.addPlayer("Steve");
        assertFalse(steve.hasPermission("hello.admin"));
        steve.addAttachment(plugin, "hello.admin", true);
        assertTrue(steve.hasPermission("hello.admin"));

        PlayerMock op = server.addPlayer("Admin");
        op.setOp(true);
        assertTrue(op.isOp());
    }

    @Test
    void config() {
        plugin.getConfig().set("some.key", "value");
        plugin.saveConfig();
        plugin.reloadConfig();
        assertEquals("value", plugin.getConfig().getString("some.key"));
    }

    @Test
    void inventory() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.getInventory().addItem(new ItemStack(Material.DIAMOND, 3));
        assertTrue(steve.getInventory().containsAtLeast(new ItemStack(Material.DIAMOND), 3));
        assertNotNull(steve.getInventory().getItemInMainHand());
    }

    @Test
    void playerState() {
        PlayerMock steve = server.addPlayer("Steve");
        steve.setGameMode(GameMode.CREATIVE);
        assertEquals(GameMode.CREATIVE, steve.getGameMode());
        steve.setHealth(10.0);
        assertEquals(10.0, steve.getHealth());
        Location target = new Location(steve.getWorld(), 10, 64, 10);
        steve.teleport(target);
        assertEquals(10, steve.getLocation().getBlockX());
    }

    @Test
    void scheduler() {
        int[] runs = {0};
        server.getScheduler().runTaskLater(plugin, () -> runs[0]++, 20L);
        server.getScheduler().performTicks(19);
        assertEquals(0, runs[0]);
        server.getScheduler().performTicks(1);
        assertEquals(1, runs[0]);
    }

    @Test
    void events() {
        server.addPlayer("Steve");
        server.getPluginManager().assertEventFired(PlayerJoinEvent.class);
    }

    @Test
    void damageFiresEventsOnlyThroughSimulateDamage() {
        int[] events = {0};
        server.getPluginManager().registerEvents(new Listener() {
            @EventHandler
            public void onDamage(EntityDamageEvent event) {
                events[0]++;
            }
        }, plugin);
        PlayerMock steve = server.addPlayer("Steve");
        PlayerMock alex = server.addPlayer("Alex");

        // damage() only lowers health: listeners never see an EntityDamageEvent.
        steve.damage(1.0);
        steve.damage(1.0, alex);
        assertEquals(0, events[0]);
        assertEquals(18.0, steve.getHealth());

        // simulateDamage() fires EntityDamageByEntityEvent (cause ENTITY_ATTACK), then applies it.
        steve.setNoDamageTicks(0);
        EntityDamageEvent event = steve.simulateDamage(1.0, alex);
        assertEquals(1, events[0]);
        assertInstanceOf(EntityDamageByEntityEvent.class, event);
        assertEquals(17.0, steve.getHealth());
    }

    @Test
    void onlinePlayersAndDisconnect() {
        PlayerMock steve = server.addPlayer("Steve");
        assertEquals(steve, server.getPlayerExact("Steve"));
        steve.disconnect();
        assertNull(server.getPlayerExact("Steve"));
    }
}
