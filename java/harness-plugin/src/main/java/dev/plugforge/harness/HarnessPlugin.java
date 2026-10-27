package dev.plugforge.harness;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryType;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryView;
import org.bukkit.inventory.ItemStack;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Test-bench helper loaded next to the plugin under test. Console-only command {@code pfh}:
 * <pre>
 * pfh ping                              -> PFH OK
 * pfh perm &lt;player&gt; &lt;node&gt; &lt;true|false&gt;  -> grants/denies one permission node (kept across rejoins)
 * pfh state &lt;player&gt;                    -> one line of JSON: health, food, position, inventory, open menu
 * pfh entities &lt;player&gt; &lt;radius&gt;        -> JSON array of entities near the player
 * pfh kill &lt;player&gt; &lt;target&gt;           -> the player kills the nearest entity of a type (or a player) with a real melee hit
 * </pre>
 * On enable it also makes the world predictable: no fall damage, no natural mob spawning, always day.
 */
public class HarnessPlugin extends JavaPlugin implements Listener {

    private static final PlainTextComponentSerializer PLAIN = PlainTextComponentSerializer.plainText();

    /** Lower-case player name -> permission node -> value. */
    private final Map<String, Map<String, Boolean>> permissions = new HashMap<>();
    private final Map<UUID, PermissionAttachment> attachments = new HashMap<>();

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
        for (World world : getServer().getWorlds()) {
            // Teleports into the air must not kill bots; scenarios summon the mobs they need.
            world.setGameRule(GameRule.FALL_DAMAGE, false);
            world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
            world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
            world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
            world.setTime(1000);
            world.setStorm(false);
        }
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (sender instanceof Player) {
            sender.sendMessage("pfh is console-only");
            return true;
        }
        if (args.length == 1 && args[0].equals("ping")) {
            sender.sendMessage("PFH OK");
        } else if (args.length == 4 && args[0].equals("perm")) {
            permissions.computeIfAbsent(args[1].toLowerCase(Locale.ROOT), k -> new HashMap<>()).put(args[2], Boolean.parseBoolean(args[3]));
            Player player = Bukkit.getPlayerExact(args[1]);
            if (player != null) apply(player);
            sender.sendMessage("PFH OK");
        } else if (args.length == 2 && args[0].equals("state")) {
            sender.sendMessage(state(args[1]).toString());
        } else if (args.length == 3 && args[0].equals("entities")) {
            sender.sendMessage(entities(args[1], Double.parseDouble(args[2])).toString());
        } else if (args.length == 3 && args[0].equals("kill")) {
            sender.sendMessage(kill(args[1], args[2]));
        } else {
            sender.sendMessage("PFH ERROR usage: pfh ping | perm <player> <node> <true|false> | state <player> | entities <player> <radius> | kill <player> <target>");
        }
        return true;
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onJoin(PlayerJoinEvent event) {
        apply(event.getPlayer());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        PermissionAttachment old = attachments.remove(event.getPlayer().getUniqueId());
        if (old != null) old.remove();
    }

    private void apply(Player player) {
        PermissionAttachment old = attachments.remove(player.getUniqueId());
        if (old != null) old.remove();
        Map<String, Boolean> nodes = permissions.get(player.getName().toLowerCase(Locale.ROOT));
        if (nodes == null || nodes.isEmpty()) return;
        PermissionAttachment attachment = player.addAttachment(this);
        nodes.forEach(attachment::setPermission);
        attachments.put(player.getUniqueId(), attachment);
        player.recalculatePermissions();
        player.updateCommands();
    }

    private JsonObject state(String name) {
        JsonObject out = new JsonObject();
        Player player = Bukkit.getPlayerExact(name);
        out.addProperty("online", player != null);
        if (player == null) return out;
        out.addProperty("name", player.getName());
        out.addProperty("health", player.getHealth());
        out.addProperty("food", player.getFoodLevel());
        out.addProperty("gamemode", player.getGameMode().name().toLowerCase(Locale.ROOT));
        out.addProperty("op", player.isOp());
        out.addProperty("world", player.getWorld().getName());
        out.addProperty("x", player.getLocation().getX());
        out.addProperty("y", player.getLocation().getY());
        out.addProperty("z", player.getLocation().getZ());
        out.add("inventory", items(player.getInventory()));
        InventoryView view = player.getOpenInventory();
        if (view.getType() != InventoryType.CRAFTING && view.getType() != InventoryType.CREATIVE) {
            JsonObject open = new JsonObject();
            open.addProperty("title", PLAIN.serialize(view.title()));
            open.addProperty("type", view.getType().name().toLowerCase(Locale.ROOT));
            open.addProperty("size", view.getTopInventory().getSize());
            open.add("items", items(view.getTopInventory()));
            out.add("open", open);
        }
        return out;
    }

    /**
     * The player kills a target: another online player by name, or the nearest living entity of a
     * type within 32 blocks. A real melee hit after lowering its health, so EntityDamageByEntityEvent
     * fires with the player as damager and EntityDeathEvent sees the player as killer.
     */
    private String kill(String name, String target) {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) return "PFH ERROR player " + name + " is not online";
        LivingEntity victim = Bukkit.getPlayerExact(target);
        if (victim == null) {
            String type = target.toLowerCase(Locale.ROOT).replace("minecraft:", "");
            double best = Double.MAX_VALUE;
            for (Entity entity : player.getNearbyEntities(32, 32, 32)) {
                if (!(entity instanceof LivingEntity living) || entity instanceof Player) continue;
                if (!entity.getType().getKey().getKey().equals(type)) continue;
                double d = entity.getLocation().distanceSquared(player.getLocation());
                if (d < best) {
                    best = d;
                    victim = living;
                }
            }
        }
        if (victim == null) return "PFH ERROR no " + target + " within 32 blocks of " + name;
        String what = victim instanceof Player p ? p.getName() : victim.getType().getKey().getKey();
        victim.setNoDamageTicks(0);
        victim.setHealth(Math.min(victim.getHealth(), 0.5));
        player.attack(victim);
        if (!victim.isDead()) victim.damage(1000, player);
        return victim.isDead() ? "PFH OK killed " + what : "PFH ERROR " + what + " survived the hit";
    }

    /** Entities (not the player) within radius of a player: type, custom name, position, health. */
    private JsonArray entities(String name, double radius) {
        JsonArray out = new JsonArray();
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) return out;
        for (Entity entity : player.getNearbyEntities(radius, radius, radius)) {
            JsonObject o = new JsonObject();
            o.addProperty("type", entity.getType().getKey().getKey());
            Component custom = entity.customName();
            if (custom != null) o.addProperty("name", PLAIN.serialize(custom));
            else if (entity instanceof Player other) o.addProperty("name", other.getName());
            o.addProperty("x", entity.getLocation().getX());
            o.addProperty("y", entity.getLocation().getY());
            o.addProperty("z", entity.getLocation().getZ());
            if (entity instanceof LivingEntity living) o.addProperty("health", living.getHealth());
            out.add(o);
        }
        return out;
    }

    private static JsonArray items(Inventory inventory) {
        JsonArray out = new JsonArray();
        ItemStack[] contents = inventory.getContents();
        for (int slot = 0; slot < contents.length; slot++) {
            ItemStack item = contents[slot];
            if (item == null || item.getType().isAir()) continue;
            JsonObject o = new JsonObject();
            o.addProperty("slot", slot);
            o.addProperty("item", item.getType().getKey().getKey());
            o.addProperty("amount", item.getAmount());
            Component name = item.getItemMeta() != null && item.getItemMeta().hasDisplayName() ? item.getItemMeta().displayName() : null;
            if (name != null) o.addProperty("name", PLAIN.serialize(name));
            out.add(o);
        }
        return out;
    }
}
