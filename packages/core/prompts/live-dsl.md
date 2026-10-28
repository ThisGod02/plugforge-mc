Live scenarios (L2) are YAML files in `src/test/scenarios/`. Bots (real Minecraft clients) join a real Paper server with the plugin and play them; a harness plugin and the server console do the rest. Before each scenario the plugin's data folder, the whole world and ops are wiped and the server restarts, so every scenario starts fresh on a newly generated world with default config (plus its own `config` overrides).

```yaml
id: shop-click-buys-bread            # lowercase, unique
covers: [AC3]                        # acceptance ids it checks, or [extra]
description: Clicking bread in /shop buys it for 10 coins
players: [alice, bob]                # 1-4 bot names, 3-16 letters/digits/_; first one is the default `as`
config:                              # optional: config.yml overrides (dotted keys), e.g. shorten timers
  tax.interval-minutes: 1
setup:                               # optional: same steps as below, run before `steps`
  - op: alice
  - perm: { player: bob, node: shop.use, value: false }
  - give: { player: alice, item: wheat, count: 5 }
steps:
  - as: alice
    command: /shop                   # a command typed by the bot (leading slash)
  - as: alice
    expect_gui: { title_contains: "Магазин", has_item: "Хлеб" }   # waits up to 5s for an open menu
  - as: alice
    click_item: "Хлеб"               # left-clicks the first menu item whose name contains the text
  - as: alice
    expect_chat: "Вы купили"         # a message containing the text, after the previous match (5s)
  - as: alice
    expect_state: { has_item: { item: bread, count: 1 } }
```

All steps (one action per step; `as` only on bot steps, required when there are several players):
- Bot: `command: /x args`, `chat: text`, `expect_chat: "text"` or `{contains|equals, within: seconds}`, `expect_no_chat: "text"` (waits 2s), `expect_gui: "title part"` or `{title_contains, has_item, lacks_item, within}`, `expect_no_gui: true`, `click_item: "name part"`, `click_slot: 13`, `close_gui: true`.
- Server: `console: "any console command"`, `expect_console: {command, contains}`, `op: name`, `deop: name`, `perm: {player, node, value}`, `give: {player, item, count}` (vanilla ids: diamond, wheat…), `teleport: {player, x, y, z}`, `damage: {player, amount}` (real damage, fires EntityDamageEvent), `kill: {player, target}` (the player kills the nearest mob of that vanilla id within 32 blocks, or the online player with that name, by a real melee hit: EntityDamageByEntityEvent has the player as damager and the victim's killer is the player — use it for kill rewards, crimes, PvP), `wait: seconds`, `restart: true` (stop and start the server keeping plugin data, everyone rejoins), `quit: name`, `join: name`.
- State: `expect_state: {player, online, health, health_below, food, gamemode, near: {x, y, z, radius}, has_item: {item, count | min, name_contains}, lacks_item: item, open_title_contains, within}` (polls up to 3s).
- Entities: `expect_entities: {player, radius, type, name_contains, count | min | max, within}` counts mobs/villagers/animals near a player (vanilla ids: zombie, villager, cow…; polls up to 5s). Speed the world up through the console when needed, e.g. `console: "gamerule randomTickSpeed 1000"` for crops, `console: "time set day"`.

World: a flat world, the ground surface is y=-60 (teleport to y=-60, never y=64); fall damage is off, mobs never spawn on their own (summon what you need: `console: "summon minecraft:zombie 3 -60 0"`), difficulty easy, always day. A `console` step fails when vanilla rejects the command ("No entity was found", "Unknown or incomplete command"…).

Rules of thumb: a scenario fails on any exception in the server log. Message texts compare as plain text (no colours). Menu titles and item names are matched by substring. Players start in survival at the world spawn with empty inventories and no permissions beyond defaults. Timers must be short: shorten them with `config`, never `wait` more than 30 seconds.
