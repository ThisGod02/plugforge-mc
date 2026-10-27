package dev.plugforge.menudemo;

import java.io.File;
import java.io.IOException;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

public class MenuDemoPlugin extends JavaPlugin implements Listener {

    static final String TITLE = "Меню";
    static final String CLICK_TITLE = "Menu";
    static final String BUTTON = "Получить алмаз";

    private File claimsFile;
    private YamlConfiguration claims;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        claimsFile = new File(getDataFolder(), "claims.yml");
        claims = YamlConfiguration.loadConfiguration(claimsFile);
        getServer().getPluginManager().registerEvents(this, this);
        getCommand("menu").setExecutor(this);
        getCommand("claims").setExecutor(this);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("Только для игроков"));
            return true;
        }
        if (command.getName().equals("menu")) {
            if (!player.hasPermission("menudemo.use")) {
                player.sendMessage(Component.text("Нет доступа"));
                return true;
            }
            Inventory inventory = Bukkit.createInventory(null, 9, Component.text(TITLE));
            ItemStack button = new ItemStack(Material.EMERALD);
            ItemMeta meta = button.getItemMeta();
            meta.displayName(Component.text(BUTTON));
            button.setItemMeta(meta);
            inventory.setItem(4, button);
            player.openInventory(inventory);
        } else {
            player.sendMessage(Component.text("Получено: " + claims.getInt(player.getUniqueId().toString(), 0)));
        }
        return true;
    }

    @EventHandler
    public void onClick(InventoryClickEvent event) {
        if (!PlainTextComponentSerializer.plainText().serialize(event.getView().title()).equals(CLICK_TITLE)) {
            return;
        }
        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player)) {
            return;
        }
        ItemStack item = event.getCurrentItem();
        if (item == null || item.getType() != Material.EMERALD) {
            return;
        }
        player.getInventory().addItem(new ItemStack(Material.DIAMOND, getConfig().getInt("reward-amount", 1)));
        String key = player.getUniqueId().toString();
        claims.set(key, claims.getInt(key, 0) + 1);
        try {
            claims.save(claimsFile);
        } catch (IOException e) {
            getLogger().warning("could not save claims.yml: " + e.getMessage());
        }
        player.sendMessage(Component.text("Вы получили алмаз"));
        Bukkit.getScheduler().runTask(this, () -> player.closeInventory());
    }
}
