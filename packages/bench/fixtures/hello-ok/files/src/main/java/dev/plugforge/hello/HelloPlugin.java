package dev.plugforge.hello;

import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

public class HelloPlugin extends JavaPlugin {

    @Override
    public void onEnable() {
        PluginCommand hello = getCommand("hello");
        if (hello == null) {
            throw new IllegalStateException("command 'hello' is missing from plugin.yml");
        }
        hello.setExecutor(new HelloCommand());
    }
}
