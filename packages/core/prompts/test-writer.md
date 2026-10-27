Write the JUnit 5 + MockBukkit unit tests for this plugin. The tests are written before the code they check and will decide whether it is accepted, so they must check exactly what the spec says, no more and no less.

## Spec
```json
{{spec}}
```
{{scope}}
{{mockbukkit}}

Rules:
- Package `{{package}}`; put your tests into the new file `src/test/java/{{packageDir}}/{{testFile}}`. Never create or change any other existing test file (they are fixed).
- For every acceptance criterion in scope write at least one `@Test` method whose name starts with the lowercase criterion id, e.g. `ac1DefaultConfigHasGreeting`, `ac2...`. A criterion may need several tests (`ac3OnlineTarget`, `ac3OfflineTarget`).
- {{codeState}} Reference only the main class `{{package}}.{{mainClass}}` (as `MockBukkit.load({{mainClass}}.class)`), its inherited `JavaPlugin` methods (`getConfig`, `saveConfig`, `reloadConfig`, `getDataFolder`), and Bukkit, MockBukkit and JUnit APIs. Never call plugin-specific methods or classes: test behaviour through commands, config, permissions and player state.
- Expected texts come from `messages` with placeholders filled in, character for character.
- Give players permissions with `setOp(true)` or `addAttachment(plugin, node, true)` as the spec implies; a plain new player has only default-true permissions.
- Each test sets up its own players and state; `@BeforeEach` mocks the server and loads the plugin, `@AfterEach` unmocks.
- Do not test things the spec leaves open (wording of usage texts not in `messages`, log output, colours). Leave menus clicks, mobs and restarts to the live scenarios.
{{feedback}}
Answer with one block:

FILE: src/test/java/{{packageDir}}/{{testFile}}
```java
...
```
