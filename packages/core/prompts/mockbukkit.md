MockBukkit 4 cheat sheet (package `org.mockbukkit.mockbukkit`; every line below is verified against the pinned version — prefer these exact calls):

```java
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;
import org.mockbukkit.mockbukkit.entity.PlayerMock;
import org.mockbukkit.mockbukkit.command.ConsoleCommandSenderMock;

@BeforeEach void setUp() { server = MockBukkit.mock(); plugin = MockBukkit.load(MyPlugin.class); }
@AfterEach  void tearDown() { MockBukkit.unmock(); }

PlayerMock steve = server.addPlayer("Steve");          // online player; names must be unique per test
steve.performCommand("home set base");                   // no leading slash
assertEquals("Home set.", steve.nextMessage());          // next message as plain text, null when none left
assertNull(steve.nextMessage());                         // nothing more was sent
steve.assertSaid("Home set."); steve.assertNoMoreSaid(); // same, as assertions

ConsoleCommandSenderMock console = (ConsoleCommandSenderMock) server.getConsoleSender();
server.dispatchCommand(console, "mycmd reload");         // console runs a command
assertEquals("Reloaded.", console.nextMessage());

steve.setOp(true);                                       // op: has every permission whose default is op
steve.addAttachment(plugin, "my.perm", true);            // grant one permission node
steve.hasPermission("my.perm");

plugin.getConfig().set("some.key", 5); plugin.saveConfig(); // write config.yml on disk (then e.g. run a reload command)
plugin.getConfig().getInt("some.key");                     // read the current value

steve.getInventory().addItem(new ItemStack(Material.DIAMOND, 3));
steve.getInventory().containsAtLeast(new ItemStack(Material.DIAMOND), 3);
steve.setGameMode(GameMode.CREATIVE); steve.getGameMode();
steve.setHealth(10.0); steve.getHealth();
steve.teleport(new Location(steve.getWorld(), 10, 64, 10)); steve.getLocation().getBlockX();
server.getPlayerExact("Steve");  steve.disconnect();      // look up / take a player offline

server.getScheduler().performTicks(20);                   // run scheduled tasks for 20 ticks (1 second)
server.getPluginManager().assertEventFired(PlayerJoinEvent.class);
```

Traps:
- One `sendMessage` call is one `nextMessage()`. Messages queue per player; read them in order.
- `nextMessage()` returns the plain text of an Adventure component. Expect exactly the spec text with placeholders filled in.
- There is no `player.chat`/`assertChat` for command replies; use `nextMessage()`.
- `addPlayer()` already fires PlayerJoinEvent; join messages the plugin sends are queued on that player.
- A non-op player without an attachment has no op-default permissions.
