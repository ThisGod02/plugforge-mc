The plugin does not pass its checks yet. Fix it.

## Spec
```json
{{spec}}
```

## Check result
```
{{check}}
```
{{history}}
## Tests (fixed, you cannot change them)
{{tests}}

## Current source files
{{files}}

Find the root cause, then fix it with the smallest change. Tests are the source of truth: change the plugin code so that it does what the test expects, with the exact texts the test asserts.

A failed LIVE scenario ran on a real Paper server with bot players: the steps marked ok happened, the FAIL step shows what was expected and what the players actually saw (chat, open menu), and any server log errors are your exceptions. Typical live-only causes: a click listener that does not recognise the menu or does not cancel the event, a listener that is never registered, data saved only in memory or only on shutdown, a task scheduled with the wrong delay, texts that differ from the spec.

Make the plugin right for a real server, never just for the test bench. The plugin must not know it is being tested: do not intercept or parse the commands a scenario uses to set things up (`/fill`, `/setblock`, `/summon`, `/tp`…), do not special-case bot names, the `pfh` harness, MockBukkit or test worlds, do not hard-code values a test expects. Every scenario starts on a freshly generated world, so leftovers from other scenarios are never the cause. If a test or scenario cannot pass with honest plugin behaviour, fix the rest and raise a `TEST_DISPUTE` (below) instead.

Answer with a short explanation (at most 3 sentences), then your edits. You may only edit files under `src/main/java` and `src/main/resources`.

To change part of a file, copy the lines to replace exactly from the current file:

<<<<<<< SEARCH src/main/java/path/To/File.java
exact existing lines
=======
replacement lines
>>>>>>> REPLACE

To create a file or replace it completely:

FILE: src/main/java/path/To/NewFile.java
```java
full file content
```

If you are sure a test itself is wrong, still fix everything else, and add one line starting with `TEST_DISPUTE:` that names the test and explains why.
