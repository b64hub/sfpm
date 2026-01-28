---
description: Command output style and JSON support for the CLI package commands
applyTo: 'packages/cli/src/**/*.ts'
---

## Output Style

Do not use emojis. Keep output language concise and clear. 

Use ui elements such as: 
- spinners: ora
- text coloring: chalk
- boxes: boxen


## JSON support

All central commands should have json output support. Not necessary for more "supportive" convenience commands.  
