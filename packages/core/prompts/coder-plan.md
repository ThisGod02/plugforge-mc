Plan the source files for this plugin.

## Spec
```json
{{spec}}
```

## Tests the plugin must pass (fixed)
{{tests}}

## Current code
{{current}}
{{scope}}
List every file under `src/main/java` or `src/main/resources` that you will create or rewrite now. {{required}}

Use the package `{{package}}` (sub-packages like `{{package}}.command` are fine). Keep one class per clear responsibility. List files in dependency order: classes other files use come first, plugin.yml last.

Answer with JSON only, no prose:
{"files": [{"path": "src/main/java/...", "purpose": "one sentence: what this file does (or what changes in it) and which classes/methods other files rely on"}]}
