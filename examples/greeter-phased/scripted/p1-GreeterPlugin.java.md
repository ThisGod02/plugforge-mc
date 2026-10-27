```java
package dev.plugforge.greeter;

import org.bukkit.plugin.java.JavaPlugin;

public class GreeterPlugin extends JavaPlugin {

    @Override
    public void onEnable() {
        saveDefaultConfig();
        getCommand("greet").setExecutor(new GreetCommand(this));
    }

    public String greetingFor(String playerName) {
        return getConfig().getString("greeting.message", "Hello, %player%!").replace("%player%", playerName);
    }
}
```
