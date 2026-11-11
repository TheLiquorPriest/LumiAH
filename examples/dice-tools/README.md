# Dice Tools: an extension with LumiAH built in

A complete, small Lumiverse extension that uses LumiAH as a package. It is LumiAH (the agents, their tools, the pages) under a name of its own, plus three things:

- **`roll_dice`**, a tool that runs in this extension's backend. A dice expression goes in (`2d6+3`), each die and the total come out. The dice are the extension's: no model ever makes up a roll.
- **Dice clerk**, an agent the main agent can hand a roll to.
- **A contested roll**, a skill: how to settle two characters acting against each other.

It claims no chat, so LumiAH's own main agent answers every chat, and holds `roll_dice` with nothing to set.

## The files

| File | What it is |
| --- | --- |
| `spindle.json` | The manifest: the extension's identifier, the permissions LumiAH's backend needs, the two bundles. |
| `src/dice.ts` | Everything Dice Tools adds: the dice, the tool, the agent, the skill, a hook. |
| `src/backend.ts` | The backend's entry: LumiAH's backend over Lumiverse, given what `dice.ts` adds. |
| `src/frontend.ts` | The frontend's entry: LumiAH's pages in a drawer tab named *Dice Tools*. |
| `package.json` | The dependency on `lumi-ah`, and the build. |

About a hundred lines of code in all. [docs/EXTENDING.md](../../docs/EXTENDING.md) walks through them.

## Build and install

```sh
bun install
bun run build
```

That writes `dist/backend.js` and `dist/frontend.js`. Push the folder to a repository of your own with `dist/` in it, and install it in Lumiverse from the Extensions tab like any extension. Then open **Dice Tools → Home**, switch it on for a chat, and ask for a roll.

Inside LumiAH's repository this example resolves `lumi-ah` to the sources beside it (`paths` in `tsconfig.json`). In a project of your own, delete `paths`: `bun install` brings `lumi-ah` in as the dependency `package.json` names.

## Make it yours

Change the identifier in `spindle.json` and `src/dice.ts` together (Lumiverse keeps each extension's storage under it), then replace the tool, the agent and the skill with your own.

`test/examples/dice-tools.test.ts` in LumiAH's repository mounts this example on a fake Lumiverse and plays a turn in which a scripted model rolls. It is the pattern for testing an extension of your own.
