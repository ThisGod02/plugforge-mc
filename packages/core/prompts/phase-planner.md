Plan how to build this plugin.

## Request
{{request}}

## Clarifications
{{answers}}
{{revision}}
Small plugins are built in one go. Big ones are built in phases: each phase ends with a working plugin that passes all tests of this and all earlier phases, and the next phase adds to it without breaking anything.

Decide the phases:
- One phase when the whole request fits into about 12 testable acceptance criteria.
- Otherwise 2-{{max}} phases. The first phase is the foundation the rest depends on (data model, storage, core commands); later phases add features on top, roughly in order of dependency and importance. Every part of the request must land in some phase: do not drop features, only order them.
- Each phase should fit into about 8-15 acceptance criteria and be testable on its own: unit tests (MockBukkit) and live tests where bots play on a real Paper server (commands, chat, inventory menus and clicks, damage, mobs and entities near players, restarts, config, several players).
- Write titles and goals in the user's language. A goal lists concretely what this phase adds: commands, menus, mechanics, data.

Answer with JSON only:
{"phases": [{"title": "short title", "goal": "what this phase adds, concretely"}]}
