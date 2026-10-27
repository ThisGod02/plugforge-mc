```java
package dev.plugforge.greeter;

import net.kyori.adventure.text.Component;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;

public class GreeterAdminCommand implements CommandExecutor {

    private final GreeterPlugin plugin;

    public GreeterAdminCommand(GreeterPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!sender.hasPermission("greeter.admin")) {
            sender.sendMessage(Component.text("You don't have permission to do that."));
            return true;
        }
        if (args.length != 1 || !args[0].equalsIgnoreCase("reload")) {
            sender.sendMessage(Component.text("Usage: /greeter reload"));
            return true;
        }
        plugin.reloadConfig();
        sender.sendMessage(Component.text("Config reloaded."));
        return true;
    }
}
```
