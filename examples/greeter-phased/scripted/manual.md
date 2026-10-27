# Greeter — manual

Greeter greets players by name and lets the administrator reload its settings without a restart.

## Quick start

1. Join the server.
2. Type `/greet` — the plugin answers with a greeting that uses your name.

## Commands

| Command | What it does | Who |
|---|---|---|
| `/greet` | Sends you the greeting from config.yml with your name filled in. | everyone |
| `/greeter reload` | Reads config.yml again and answers "Greeter config reloaded." | administrators (`greeter.admin`) |

## For the administrator

Copy the jar into `plugins/` and restart the server. The first start creates `plugins/Greeter/config.yml`; change the greeting there and run `/greeter reload`. Players without `greeter.admin` get the no-permission message instead of a reload.
