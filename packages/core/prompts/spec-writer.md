Write the specification (spec.json) for this plugin.

## Request
{{request}}

## Clarifications
{{answers}}
{{revision}}
## JSON Schema
```json
{{schema}}
```

Rules:
- `name` is PascalCase; `package` is `dev.plugforge.<lowercase name>`; `mainClass` is `<name>Plugin`.
- Put every text the plugin sends into `messages` (plain text, no colour codes; use placeholders like `%player%`, `%amount%`). Use the user's language for these texts.
- Each command has a `usage`. Use `permission` on a command only if Bukkit's default "no permission" text is acceptable; when the plugin must answer with its own `noPermission` message, leave `permission` out of the command and list the node in `permissions` instead (the code checks it).
- Every value server owners might tune goes to `config` with a default.
- `acceptance`: 3-12 criteria with ids AC1, AC2, ... Each one is a single observable behaviour that a MockBukkit unit test can check: "who does what" → "exact result" (message key and text, config value, inventory/health/location/gamemode change, permission outcome). Cover the main success path of every command and the important failure paths (no permission, wrong arguments, unknown/offline player, console where it matters).
- If the request needs something the test bench cannot provide yet (Vault economy, databases, web APIs, custom textures, GUIs driven by clicks are fine), make the simplest faithful version and say what you simplified in `assumptions`.
- `assumptions`: every default you chose that the user did not state, in the user's language, one short sentence each.

Answer with the JSON object only.
