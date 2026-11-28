# Releasing

A release is one tag on a commit of main. Everything else follows from it in `.github/workflows/release.yml`.

## A release

1. `version` in `package.json` moves (it moves with every push of main that changes what a user gets), and the
   changelog (`site/content/changelog.md`) has a section `## <version> (<date>)` saying what changed. Until the
   release that heading says `## <version> (not released yet)`: in the same commit as the version, write the
   release date in its place (such as `## 0.3.3 (2 December 2026)`). Nothing writes it for you, and
   `tools/release-notes.mjs` refuses a release whose heading still says "(not released yet)".
2. `node tools/build-skill.mjs`: the Hoprig skill carries the version, and the `hoprig-skill` package gets the same
   version. The tests fail until this is done. Commit all of it, push main, and wait until the `test` workflow
   has passed on that commit: on Linux and macOS with Node.js 24 (the lowest Hoprig runs on, `src/nodefloor.mjs`)
   and 26. Its Windows jobs, on the same two versions, may fail: Windows is experimental, and its jobs do not hold a release back.
   Before a tag, the release job's own order and limits (the tests run as the `test` workflow runs them, within 40 minutes) are what counts.
3. `node tools/test.mjs test/workspace/lostcomputer.test.mjs`: the proof that a lost computer costs nothing. It
   builds a workspace with work in progress on a temporary home, runs the upkeep and a drop, deletes that home,
   restores on a second one from a stand-in git server on disk, and compares every repository. Read its last line:
   every result must have arrived, with no test failed. Do not tag when it fails.
4. Tag that commit of main and push the tag:

   ```sh
   git tag v0.3.3 && git push origin v0.3.3
   ```

The workflow then checks that the tag is `v` and the version, that the changelog has its section
(`node tools/release-notes.mjs v0.3.3` does the same check on your computer) and that the tag's commit is on main,
runs the tests, makes the GitHub release with that changelog section as its notes, and publishes both packages to
npm: `hoprig` and `hoprig-skill`, with provenance. A tag that does not pass these checks makes nothing.

**A release that stopped half-way** (one package published, the other not; a registry error): **Re-run failed
jobs** in the run. Every step can run again: a GitHub release or a package version that is there already is
skipped. **A tag released while publishing was off** (`NPM_PUBLISH` was not `on`): once it is on, **Actions** →
**release** → **Run workflow**, with **Use workflow from** set to the tag (such as `v0.3.3`, under **Tags**), not
to a branch: npm's provenance names the commit the run was started from, so the workflow refuses a run that was
not started from a tag. It goes through the same checks and tests, leaves the release as it is and publishes what
is not on npm yet.

## The one-time step (the owner's)

npm publishing uses npm's trusted publishing: npm trusts this repository's release workflow, so no npm token is
stored anywhere. Until it is set up, a release is made on GitHub and nothing goes to npm (the run's summary says so).

**Before main gets the `hoprig-skill` package** (the site, `llms.txt`, the README and `docs/SKILLS.md` tell people
and AI tools to run `npx hoprig-skill`): publish it once by hand, so that nobody else can take the name. A
placeholder holds it, as `hoprig` 0.0.1 held that one: in `packages/hoprig-skill`, with its `version` set for the
moment to `0.0.1` (lower than any release tag; not committed), `npm publish --access public`. The site's deploy
refuses to publish a page that tells readers to run `npx <name>` while `<name>` is not on npm.

**Do the rest on the day of a release tag.** A trusted publisher that is new must make its first publish within
2 days; after that it expires, cannot be used or edited, and has to be deleted and set up again. So: set up both
trusted publishers, turn `NPM_PUBLISH` on, and push the tag (or run the workflow for a tag) the same day.

1. On npmjs.com, signed in with the account that owns the packages (with its security key), for **each** of
   `hoprig` and `hoprig-skill`: the package's **Settings** → **Trusted publishing** → **GitHub Actions**, with the
   organisation or user `allswebtech`, the repository `hoprig`, the workflow file `release.yml` and the
   environment `npm`. The workflow's publish job runs in that environment, so npm trusts no other run.
2. On GitHub, optionally: the repository's **Settings** → **Environments** → `npm` (made by the first run, or by
   hand) → **Required reviewers**: then every publish waits for that person's yes.
3. Optionally, on npmjs.com, in the package's settings, **Publishing access**: require two-factor authentication
   and disallow tokens.
4. On GitHub: the repository's **Settings** → **Secrets and variables** → **Actions** → **Variables** → a
   repository variable `NPM_PUBLISH` with the value `on`.

From then on, every release tag also publishes. Setting `NPM_PUBLISH` to anything else stops publishing again.
A version that was published by hand is skipped by the workflow (it is on npm already).
