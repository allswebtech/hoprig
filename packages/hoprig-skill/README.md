# hoprig-skill

Puts the [Hoprig](https://hoprig.com) skill into an AI coding tool's skills folder, without installing Hoprig. The
skill teaches the coding tool to use Hoprig: check the setup, see sessions, providers and usage limits, continue a
session on another provider, keep tasks, get projects, manage other computers and skills; read-only first, and the
user decides every change. It follows the [Agent Skills](https://agentskills.io) format.

```sh
npx hoprig-skill --claude              # your own Claude Code skills (~/.claude/skills)
npx hoprig-skill --agents              # the folder coding tools share (~/.agents/skills)
npx hoprig-skill --project ./my-app    # one project's own (my-app/.claude/skills)
npx hoprig-skill --claude --dry-run    # what it would write; writes nothing
npx hoprig-skill --print               # the skill's text
npx hoprig-skill --claude --remove     # take it away again
```

- The skill's files are made by Hoprig's own build from each command's help, so they match the version of this
  package (the same as Hoprig's).
- Beside `SKILL.md` it writes `.hoprig-skill.json`: the version and a SHA-256 of each file it wrote. A later run
  replaces only a copy it wrote and nobody changed; an edited copy is left alone, and the run shows what would
  change. `--force` is your word to replace or remove it anyway.
- It never follows a link out of the skill's folder, and in a project not out of the project's `.claude/skills`
  either. A skills folder you linked yourself (`~/.claude/skills` to a folder of your own) is where it writes.
- A copy that Hoprig installed (`hoprig skills add hoprig`) is Hoprig's to update: `hoprig skills update hoprig`.

Node.js 24.13.1 or later. No dependency. Apache-2.0.
