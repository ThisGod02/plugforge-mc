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
