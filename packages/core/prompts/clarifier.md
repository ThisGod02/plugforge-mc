A user wants a plugin. Decide whether you must ask them something before writing the specification.

## Request
{{request}}
{{previous}}
Things that usually matter: which commands and arguments; who may use each command (everyone, ops, a permission); what happens on wrong input, unknown or offline players and console use; what is stored and whether it must survive restarts; which values server owners should configure; message language and wording.

Never ask the user to cut scope or postpone features: big requests are built automatically in phases. Ask only about choices that change the plugin's behaviour and that you cannot sensibly default. Everything else you will default yourself and show to the user as an assumption later, so do not ask about trivia (names, colours, exact wording). Ask at most {{maxQuestions}} questions; ask none if the request is clear enough.

Write each question in the user's language, with 2-4 short concrete options. Put the option you recommend first.

Answer with JSON only:
{"questions": [{"id": "q1", "question": "...", "options": ["recommended option", "other option"]}]}
or, when nothing needs asking:
{"questions": []}
