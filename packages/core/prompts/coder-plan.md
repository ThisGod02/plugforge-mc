Plan the source files for this plugin.

## Spec
```json
{{spec}}
```

## Tests the plugin must pass (fixed)
{{tests}}

List every file under `src/main/java` or `src/main/resources` that must exist. Always include:
- `{{mainClassPath}}` (main class),
- `src/main/resources/plugin.yml`,
- `src/main/resources/config.yml` if the spec has config keys.

Use the package `{{package}}` (sub-packages like `{{package}}.command` are fine). Simple plugins need 2-6 files. List files in dependency order: classes other files use come first, plugin.yml last.

Answer with JSON only, no prose:
{"files": [{"path": "src/main/java/...", "purpose": "one sentence: what this file does and which classes/methods other files rely on"}]}
