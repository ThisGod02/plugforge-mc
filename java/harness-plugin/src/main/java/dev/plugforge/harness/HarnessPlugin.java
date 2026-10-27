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
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
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
 * </pre>
 */
public class HarnessPlugin extends JavaPlugin implements Listener {

    private static final PlainTextComponentSerializer PLAIN = PlainTextComponentSerializer.plainText();

    /** Lower-case player name -> permission node -> value. */
    private final Map<String, Map<String, Boolean>> permissions = new HashMap<>();
    private final Map<UUID, PermissionAttachment> attachments = new HashMap<>();

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
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
        } else {
            sender.sendMessage("PFH ERROR usage: pfh ping | perm <player> <node> <true|false> | state <player>");
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
