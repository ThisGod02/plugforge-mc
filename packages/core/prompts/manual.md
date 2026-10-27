Write the complete user manual for the Minecraft plugin below. It ships next to the plugin jar and is all the server owner and the players get: someone who never saw the request must be able to install, configure and play with it from this manual alone.

## Spec
```json
{{spec}}
```

## Plugin code
{{files}}

Describe what the code actually does. Read it for real numbers and rules: timers, prices, formulas, limits, who may do what, what is saved and when. Where the code and the spec disagree, describe the code. Never invent commands, buttons or features that are not in the code. Quote chat messages and menu texts exactly as the code sends them.

Write in the same language as the spec's messages, plain words for non-programmers, Markdown. Cover, as the plugin has them:
1. What the plugin is: a short overview of its systems and how they fit together.
2. Quick start: the first steps of a new player, in order, with the commands to type.
3. Commands: every command and sub-command with syntax, what it does, who may use it, an example and the typical replies or errors.
4. Menus: every menu, how to open it, what each button shows or does.
5. How it works: each game mechanic in detail, with the numbers and formulas from the code and config (for example how income is counted, when something grows or expires, what happens on death or restart).
6. For the administrator: installation, permissions with defaults, every config.yml key with its effect and default, where data is stored and how to back it up, how to reset it.
7. Questions and problems: common mistakes and their replies, and limits worth knowing.

Start with `# {{name}} — {{manualTitle}}`. Answer with the Markdown only, no code fence around it and no remarks before or after.
