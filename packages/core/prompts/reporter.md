The plugin below passes all its unit tests. Your job is to tell the server owner honestly what those tests do NOT prove.

## Spec
```json
{{spec}}
```

## Tests
{{tests}}

## Plugin code
{{files}}

List behaviours that the code implements or the spec promises (including its `assumptions`) but that no test checks, or that a test checks only partly. Think about what a server owner would rely on: inventory menu clicks, data surviving a restart or crash, scheduled tasks, what other players see, permission defaults, limits and edge cases, numbers shown in messages. Read the tests carefully: do not list anything they actually assert. Also name places where the code visibly differs from the spec.

At most 10 items, most important first. Write `what` in the same language as the spec's messages, as one short sentence a non-programmer understands. `where` is the main source file. `risk` is how likely and how bad a hidden bug there would be: high, medium or low.

Answer with JSON only:
{"untested": [{"what": "...", "where": "ProfileMenu.java", "risk": "high"}]}
