---
name: adopt-projects
description: Brings the projects a computer already has into the Hoprig workspace layout - looks only in the folders the owner names, suggests one plan per project, and arranges each by a proved copy after his yes. The commands do the mechanical part (hoprig adopt scan, plan, apply, verify); this skill does the reading and the asking. Use when the owner says his computer already has projects, asks to bring, arrange, adopt or move existing projects or folders into the workspace, or names a folder such as ~/code or D:\work that holds them.
---

# Adopt the projects a computer already has

You help the owner bring projects that already live on this computer into the workspace layout
(`projects/<name>/` with `code/<repo>/`, `ai_brain/`, `scripts/`, `test-data/`). The commands copy and prove; you read
what needs reading and ask him what is his to decide. You never decide for him what this skill marks as his.

## Never, in any step

- Never look in a folder he did not name or confirm. Never the whole disk.
- Never commit his uncommitted work, never fetch, push or make a repository on a server, never choose between two
  accounts, never put the AI brain on a server.
- Never change, rename or delete an original folder. Never run `hoprig adopt retire` yourself: it is his, on his
  terminal, with the project's name typed.
- Never open, list or search a private folder (`no-ai`, `ignore`, `ai-ignore-dir`): it is counted, never read.
- Never run another tool's hook, script or `package.json` script to see what it does: read it as text.
- Never print a secret. When a file holds one, say "a secret" and the file, never the value.

## Steps

1. **Where to look.** Run `hoprig adopt scan` with no folder: it looks at nothing and lists the usual folders that are
   there. Ask him which of them hold his projects, or which other folder does. Wait for his answer.
2. **Look.** `hoprig adopt scan --in <folder>` (repeat `--in` for more). It changes nothing and does not fetch: ahead
   and behind are as of the last fetch. Tell him, per project, in plain words: its repositories, what is not
   committed, stashes, other branches, worktrees, and anything that makes a copy unsafe now (a program working in
   it, files changed within the hour). For an unsafe one, ask him to end that work first. Then ask which projects
   he wants arranged, and **wait for his answer**: do not plan a project he has not chosen, or one he is still
   working in.
3. **Suggest.** For each project he wants: `hoprig adopt plan <folder>`. It writes only the plan file (it says where)
   and prints the plan. Then read what the plan marks as needing reading, and say what you found:
   - a note (`ai_brain/notes/…`): is it the plan the project came from (then it belongs in `docs/` or the brain), or
     a log of one piece of work, perhaps with secrets in it (then it stays out of the brain, or goes to `test-data/`)?
   - a rules file of another tool: which part is about him (his ways of working: it may go into the brain's rules,
     with his yes) and which is about the project (it stays with the project);
   - a hook of another tool: what it guards. If it guards something (a folder no tool may read, a command that must
     not run), say that Claude Code needs its equal; it was not brought over by itself;
   - the files and lines that name an old folder: each one, and what it would need to say after the move;
   - each repository's line "on its server": public or private as GitHub said (asked with this computer's sign-in
     when the plan was made), or "not known". Say a public one plainly;
   - untracked folders that look like another project inside a repository: name each; a first push could take it,
     so it is his to decide whether it belongs there.
   You may edit the plan file with his agreement (where a neighbour goes, a repository's name under `code/`). Keep
   every place inside the new project folder; `apply` refuses anything else.
4. **One yes per project.** Show him the plan in short: what goes where, what stays, what would break, what needs his
   word. Ask: "Arrange <name> like this?" Nothing happens before his yes. Ask also under which name and e-mail the
   new folder's first commit is made (only for this command: `--name` and `--email`).
5. **Dry run, then a second yes, then arrange.** `hoprig adopt apply <name> --dry-run --name … --email …` (the name
   and e-mail he gave, so the dry run shows who the commit will be by), and show him its lines as
   they are (a line marked as a warning too). Ask again: "Arrange <name> now?" and **wait for his answer**. Only
   after this second yes: `hoprig adopt apply <name> --name … --email …`. Show him each proof line (HEAD, every ref,
   status, staged work, stashes, remote, worktrees, the file set, fsck).
   If it says the folder changed since its plan, make the plan again (step 3) and ask again. If a copy differs,
   apply has removed what it made: say what differed and stop for that project.
6. **After.** Tell him what still needs him, exactly as `apply` listed it: old paths in the copy's git settings,
   hooks, launch and tool files (file and line), rules files to read with him, hooks that need their equal, and the
   count of secret-shaped values in what a first push would take, tracked and untracked files, with each
   repository's visibility beside it (look before any first push; never offer to commit and push in one step). The
   coding tool's conversations
   and memory of the old folders were copied under the new ones; `hoprig sessions move <old> <new>` copies them for
   any other folder.
7. **Verify.** `hoprig adopt verify <name>`: the copy proved again. A difference is a change made since (his, or a
   program's).
8. **Report.** One short report: each project, where it is now, its proof, what needs him, and that his old folders
   are untouched. End with: "When you are sure, `hoprig adopt retire <name>` on your terminal removes the old
   folders; it checks first that nothing in them changed since the copy, compares every original with its copy
   again itself (commits, branches, tags, stashes, worktrees, files), removes nothing if the copy lacks anything, and
   asks for the name." Do not run it.
