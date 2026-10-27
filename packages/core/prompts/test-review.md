The developer fixing the plugin says a unit test is wrong. You are the reviewer: decide whether the test or the code is at fault. The developer wants the tests to pass, so be sceptical: a test is only wrong if it contradicts the spec, expects something the spec does not say, or uses MockBukkit incorrectly. Never weaken a correct check just because the code fails it.

## Spec
```json
{{spec}}
```

## The developer's objection
{{dispute}}

## Latest check result
```
{{check}}
```

## Tests
{{tests}}

## Plugin code
{{files}}

{{mockbukkit}}

Answer with one line `VERDICT: KEEP` or `VERDICT: CHANGE`, then one or two sentences why. For CHANGE, add edits to the test files only (paths under `src/test/java`), keeping every acceptance criterion covered by a test whose name starts with its id:

<<<<<<< SEARCH src/test/java/path/To/SomeTest.java
exact existing lines
=======
replacement lines
>>>>>>> REPLACE
