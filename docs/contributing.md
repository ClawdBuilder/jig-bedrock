# Contributing

Notes for people who change this package. Users do not need this page.

This repository is public. A commit, a page or a test must hold no company name, no account id, no real AWS profile
name (use `my-profile`) and no private word. Two checks enforce it: the scan and the commit-email guard.

## Everyday commands

| Command                                                          | What it does                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm ci`                                                         | Install the exact dependencies.                                                   |
| `npm test`                                                       | Run every test (`node --import ./test/support/host.mjs --test "test/*.test.ts"`). |
| `node --import ./test/support/host.mjs --test test/docs.test.ts` | Run one test file.                                                                |
| `npm run check`                                                  | Typecheck with `tsc`, then lint with Biome.                                       |
| `npm run scan`                                                   | The private-word and secret scan (below).                                         |
| `npm run check:emails`                                           | The commit-email guard (below).                                                   |
| `npm run check:packed`                                           | The packed-install check (below).                                                 |

Tests do not touch your real home. `test/support/host.mjs` gives each test process a temporary home, a fake `aws` program
that always fails, an empty Pi agent folder and empty AWS files, and removes the AWS key variables, so no test can read
your AWS configuration or call AWS.

## The scan

`npm run scan` walks the tree (not `.git` or `node_modules`) and reads every `.ts`, `.js`, `.md`, `.json`, `.mjs`,
`.yml`, `.yaml` and `.txt` file. It looks for secret shapes (an AWS access key id, a private key header) and for private
words. It prints `file:line` for each hit and never the word, then `scan: N hits`. It exits with 1 when there is a hit.

The word list is never in this repository. The scan reads it from, in order: `JIG_SCAN_WORDS_TEXT` (the list itself,
one word per line; CI passes it from the `SCAN_WORDS` repository secret), then the file named by `JIG_SCAN_WORDS`, then
`~/.config/jig/scan-words.txt`. With no list (a fork's CI) it checks secret shapes only and says so.

## The commit-email guard

`npm run check:emails` checks the author and committer address of every commit in `origin/main..HEAD` (or
`origin/$GITHUB_BASE_REF..HEAD` in a pull request). It reads the same private list as the scan. An address that matches
the list fails the run, and the output names the commit, never the address.

Without a list, only two kinds of address are public: `noreply@example.com` and any address at
`users.noreply.github.com`. Any other address gives a warning and does not fail the run. Set your commit identity before
you commit:

```sh
git -c user.name="Jig Contributors" -c user.email="noreply@example.com" commit -m "..."
```

The optional pre-push hook is not installed for you. To use it, copy `scripts/pre-push-commit-emails.sh` to
`.git/hooks/pre-push` and make it executable.

## Real-check scripts

Two scripts run the package against real AWS. They are for the maintainer, are never shipped, and are never run by CI.
They cost a little money and need an AWS profile that can call Bedrock, so run them only when you have the owner's
approval.

- `node scripts/real-check-discovery.mjs --profile <aws-profile> [--regions us-east-1] [--tag <value>] [--keep]` runs the
  package's own discovery against a real AWS profile and prints counts. The catalog goes to a temporary folder. `--tag`
  runs discovery by tag; without it, AWS-defined inference profiles are listed.
- `node scripts/real-check-messages.mjs <model-id[,model-id...]> <package-copy-dir> --profile <aws-profile>
  [--thinking high,off] [--retention short|long] [--region us-east-1] [--team <value> | --profiles arn,arn] [--pi <path>]
  [--timeout 240] [--keep] [--dry-run] [--fake-aws]` runs, for each model and thinking level, a session that thinks,
  loads a tool with `tool_search`, calls it and answers, in a temporary home with the real `~/.aws` linked in. It prints
  the cache read and write of each call and one table. On Messages a row passes only when the call after the tool load
  read the prompt from the cache. `--dry-run` and `--fake-aws` check the script itself without AWS.

Those runs are how the route table in [How it works](how-it-works.md#which-route-a-model-gets) was made. When a Pi release
adds a Claude model, run the second script for it before you trust the route rule.

## How CI works

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. All of its jobs must pass: `ci-ok` waits
for them and is the one check to require.

- **Checks** runs the email guard, the scan, `npm run check` and `npm test` on Node 22.19.0 (the lowest the package
  allows), 24 and 26.
- **Pi versions** runs the tests against Pi 1.5.0 (the oldest supported Pi) and against the newest Pi on npm.
- **Packed install** runs the packed-install check on both of those Pi versions.
- **macOS** runs `npm run check` and `npm test` on macOS. It proves the unit tests, not a real AWS run.

### How CI installs Pi

The repository pins one Pi as a development dependency. `node scripts/install-pi.mjs <version|latest>` installs another
Pi over it in `node_modules`, without changing `package.json` or the lockfile. Pi's two packages release together, so one
version number is installed for both. `latest` is asked of the npm registry at run time, so a Pi release that breaks the
package shows up as a failure at once. To try it yourself, use a clean checkout: it replaces Pi in `node_modules`.

### The packed-install check

`npm run check:packed` is the package as a user gets it. It packs the folder with `npm pack`, installs the tarball the way
`pi install npm:@clawdbuilder/jig-bedrock` does, starts Pi in rpc mode, and proves the extension loaded. A small server on
`127.0.0.1` answers for this one package name with the new tarball and passes every other name (the AWS SDK, for one) to
the public registry, so the dependencies install for real. It gives Pi a temporary home, removes every `AWS_*`, `PI_*` and
`JIG_*` variable, never calls AWS, and deletes its folder. It checks that the installed package holds the files a user
needs (`index.ts`, `src`, `docs`, `README.md`, `CHANGELOG.md`, `LICENSE`), none of the folders a user must not get
(`test`, `scripts`, `.github`), and the dependencies at the pinned versions.

## The pages

The README and these pages are checked by `test/docs.test.ts`: every setting in the code is in `docs/settings.md`, every
setting that page names exists, every `JIG_BEDROCK_*` variable named anywhere exists in `src/`, every relative link and
image points at a file that is published, and no page uses "profile" without a word before it ("AWS profile" or
"inference profile"). Each meaning has one home: the words and the route rule in `docs/how-it-works.md`, the settings in
`docs/settings.md`, symptoms in `docs/troubleshooting.md`. The other pages point there. Diagrams are hand-written SVG in
`docs/img/`, with their own marker ids, an `aria-label`, and text of 11 to 13 pixels.

Images in the README use the full `https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/...` address,
so they show on GitHub, npm and Pi's package gallery. They show the version on `main`, so change a diagram and its
caption in the same pull request.

## A release

A tag publishes. The tag, `package.json` and the `## [version]` section of `CHANGELOG.md` must name the same version
(`.github/workflows/publish.yml` checks it, with `scripts/release-notes.mjs`). Tag only after `ci-ok` has passed on the
merge commit: the workflow refuses a commit without it. The workflow publishes to npm with Trusted Publishing and
provenance, waits for npm to report the version, then writes the GitHub release page from the changelog section.

[Back to the README](../README.md).
