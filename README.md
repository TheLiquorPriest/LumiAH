# LumiAH: the Lumiverse Agentic Harness

LumiAH is an agent harness for [Lumiverse](https://github.com/prolix-oc/Lumiverse), in the spirit of command-line coding harnesses. A main agent works in a loop with tools, sub-agents, sessions, a workspace and guidance files, and answers Lumiverse's main generation through a loopback connection. A reply then comes from an agent loop instead of one model call.

**Status:** early design. Nothing is built yet.

## What it will be
- **A runtime:** a process that runs beside Lumiverse. It serves the loopback connection and runs the agents.
- **A Lumiverse extension:** the side that faces Lumiverse. It reads the active preset and the activated lore, reaches the user's chats and model connections, and holds all of the UI.
- **A package:** the harness core, which other extensions can depend on to register their own tools, agents, skills and guidance. [LumiRPEngine](https://github.com/TheLiquorPriest/LumiRPEngine) is the first.

## Credits
[LumiAgent](https://github.com/AMousePad/LumiAgent) by AMousePad (MIT) is a design reference.
