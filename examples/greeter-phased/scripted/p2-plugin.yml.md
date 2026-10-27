```yaml
name: Greeter
version: '${version}'
main: dev.plugforge.greeter.GreeterPlugin
api-version: '1.21'
description: "Greets players with a configurable message; admins can reload the config."
commands:
  greet:
    description: Greet yourself or another online player
    usage: /greet [player]
  greeter:
    description: Greeter admin commands
    usage: /greeter reload
permissions:
  greeter.admin:
    description: Use /greeter reload
    default: op
```
