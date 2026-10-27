Write live scenarios for this plugin. They run after the unit tests pass and decide whether the plugin really works in the game, so they must check exactly what the spec says, with its exact texts.

## Spec
```json
{{spec}}
```

## Unit tests already written (MockBukkit)
{{tests}}
{{scope}}
{{dsl}}

Write 1-{{max}} scenarios for behaviour unit tests cannot prove or that matters most to players:
- clicking items in inventory menus and what the click does;
- data that must survive a server restart (use `restart: true`);
- real events: damage, joining, quitting, several players seeing each other's actions;
- timers and scheduled tasks (shorten them with `config`);
- permission outcomes for real players.
If the plugin has none of these, write one scenario that plays its main command as a real player.

The plugin code does not exist yet. Use only names the spec fixes: commands, messages (placeholders filled in), menu titles and item names it states, config keys. Do not depend on slot numbers or texts the spec does not state; prefer `click_item` and `has_item` with names from the spec. Keep each scenario focused (under 25 steps).
{{feedback}}
Answer with one block per file:

FILE: src/test/scenarios/<id>.yml
```yaml
...
```
