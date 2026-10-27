package {{package}};

import org.bukkit.plugin.java.JavaPlugin;

// Not final: MockBukkit loads plugins through a generated subclass.
public class {{mainClass}} extends JavaPlugin {

    @Override
    public void onEnable() {
        getLogger().info("{{name}} enabled");
    }

    @Override
    public void onDisable() {
        getLogger().info("{{name}} disabled");
    }
}
