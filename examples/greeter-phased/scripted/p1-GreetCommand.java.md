```java
package dev.plugforge.greeter;

import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

public class GreetCommand implements CommandExecutor {

    private final GreeterPlugin plugin;

    public GreetCommand(GreeterPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            if (!(sender instanceof Player player)) {
                sender.sendMessage(Component.text("Usage: /greet <player>"));
                return true;
            }
            player.sendMessage(Component.text(plugin.greetingFor(player.getName())));
            return true;
        }
        Player target = Bukkit.getPlayerExact(args[0]);
        if (target == null) {
            sender.sendMessage(Component.text("Player not found: " + args[0]));
            return true;
        }
        target.sendMessage(Component.text(plugin.greetingFor(target.getName())));
        sender.sendMessage(Component.text("Greeted " + target.getName() + "."));
        return true;
    }
}
```
