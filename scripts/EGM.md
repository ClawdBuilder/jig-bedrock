# scripts

## Overview

Maintainer and CI tooling for the package (`.mjs` and `.sh`). It is not published to npm: `package.json` `files` leaves `scripts/` out. Three groups:

- **Privacy gates** keep the public tree free of company words, machine paths, secrets and private commit emails.
- **Release plumbing** installs a chosen Pi version, packs and installs the tarball into a stock Pi, extracts release notes, and files an issue when a scheduled run fails.
- **Real-AWS checks** are run by hand against a real AWS profile and are never run by CI.

Only `scan`, `check:emails`, `check:packed` and `pi:install` have an npm script; the rest are called from `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, a git hook, or by hand. CI and release steps: [Contributing](../docs/contributing.md).

## Interface

| Script                      | Run by                                    | Command line and exit codes                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan-company-strings.mjs`  | `npm run scan`; CI                        | No arguments. Prints `<relative path>:<line>` per hit and `scan: N hits, <note>`. Exit 1 on any hit. Exports `hasMachinePath(line)`.                                                                                                                                                                                               |
| `check-commit-emails.mjs`   | `npm run check:emails`; CI; optional hook | No arguments. Range from `JIG_COMMIT_RANGE`, else `origin/$GITHUB_BASE_REF..HEAD`, else `origin/main..HEAD`. Exit 1 when an author or committer email matches the private list; 0 when clean, warn-only, or no range.                                                                                                              |
| `pre-push-commit-emails.sh` | git `pre-push`, only if copied by hand    | No arguments. Exits with the status of `check-commit-emails.mjs`.                                                                                                                                                                                                                                                                  |
| `install-pi.mjs`            | `npm run pi:install`; CI                  | `<version\|latest>`. Exit 2 on a missing or non-semver argument; 1 when an installed Pi package differs from the request. Exports `resolveVersion`, `installedVersion`.                                                                                                                                                            |
| `packed-install-check.mjs`  | `npm run check:packed`; CI                | `[--pi <path>] [--keep]`. Prints `ok` or `FAIL` per check. Exit 0 only when all pass; 1 on a failed check or error; 130 on SIGINT; 143 on SIGTERM. Exports `cleanEnvironment`.                                                                                                                                                     |
| `release-notes.mjs`         | `publish.yml`                             | `<version> [--root <folder>]`. Prints the `CHANGELOG.md` section. Exit 2 on usage error; 1 when the section is missing or empty. Exports `notesFor(changelog, version)`.                                                                                                                                                           |
| `scheduled-issue.sh`        | `ci.yml`, after a scheduled failure       | No arguments; needs `RUN_URL` and `gh`. Comments on the open `Scheduled CI failed` issue, or opens one.                                                                                                                                                                                                                            |
| `real-check-discovery.mjs`  | manual                                    | `--profile <aws-profile> [--regions] [--tag] [--keep] [--help]`. Runs `src/aws-discovery.ts` against real AWS with the package's own signed HTTPS calls (from `src/aws-api.ts`, passed in as `options.api`) and counts them by kind; `--tag` runs the tagged discovery. Exit 2 without `--profile`; 0 on status `ok`; otherwise 1. |
| `real-check-messages.mjs`   | manual                                    | `<model-id[,...]> <package-copy-dir> --profile <aws-profile> [options]`. Per model and thinking level: a thinking reply, a deferred tool load, and a cache read/write table. `--dry-run` and `--fake-aws` make no real call. Exit 2 on usage error; 1 when a row fails.                                                            |

Related contract: [src](../src/EGM.md), which `real-check-discovery.mjs` imports.

## Invariants

- The private word list is never in the repository. `JIG_SCAN_WORDS` names a file (default `~/.config/jig/scan-words.txt`) or `JIG_SCAN_WORDS_TEXT` carries the text (a CI secret). With no list, only secret shapes and machine paths are checked.
- Scan and email output give only locations: a `file:line`, or a 12-character sha prefix with `author` or `committer`. The matched word, its context and the email never appear.
- `hasMachinePath` allows only the placeholder names `me`, `you`, `user` and `<user>` in `/home/`, `/Users/` and `C:\Users\` paths. A page that needs an example path uses one of them.
- `check-commit-emails.mjs` never blocks a fork: with no word list it warns about anything except `noreply@example.com` and `*@users.noreply.github.com` and still exits 0. An unavailable git range skips the check.
- The pre-push hook is optional and is never installed automatically.
- A tag whose `CHANGELOG.md` section is missing or empty publishes nothing (`release-notes.mjs` exits 1).
- `install-pi.mjs` installs with `--no-save`, so `package.json` and the lockfile stay unchanged; both Pi packages must end at the requested version.
- `packed-install-check.mjs` runs the user's real `pi install npm:<name>@<version>`; only the registry is swapped, for a local `127.0.0.1` server that serves this package's tarball and passes every other name through. Pi and npm get a temporary home with `AWS_*`, `PI_*` and `JIG_*` removed. It never calls AWS and never touches the real Pi folder. The installed package must hold `package.json`, `index.ts`, `src`, `CHANGELOG.md`, `README.md`, `LICENSE` and `docs`, and no `test`, `scripts` or `.github` folder.
- Real-AWS scripts are manual-only and never run by CI. They print no credentials and replace 12-digit account ids with `<account>`. `real-check-messages.mjs` links the real AWS config folder into its isolated home and never copies it; `--team` and `--profiles` exclude each other.
- Every temporary tree is removed at exit, on SIGINT and on SIGTERM, unless `--keep`.

## Side Effects

- **Disk:** `scan-company-strings.mjs` reads every text file in the repository (`ts`, `js`, `md`, `json`, `mjs`, `yml`, `yaml`, `txt`, `sh`, `bash`, `zsh`; `.git` and `node_modules` skipped) and the private word file. `install-pi.mjs` changes `node_modules` through npm. The packed and real checks create temporary folders, a packed tarball, and in the real-AWS case a `bedrock.json` and (with `--fake-aws`) a stub `aws` script.
- **Network:** `install-pi.mjs` asks the npm registry. `packed-install-check.mjs` runs a local registry on `127.0.0.1` and forwards other package names to the public registry. `scheduled-issue.sh` calls the GitHub API through `gh`. `real-check-discovery.mjs` calls real AWS (STS, Bedrock listing, tagging) over HTTPS. `real-check-messages.mjs` reaches real AWS through the package under test unless run with `--dry-run` or `--fake-aws`.
- **Child processes:** `git log`, `npm view`, `npm install`, `npm pack`, the `pi` binary (`install`, `--mode rpc`), the `aws` program, and `gh`.
- **Environment read:** `JIG_SCAN_WORDS`, `JIG_SCAN_WORDS_TEXT`, `JIG_COMMIT_RANGE`, `GITHUB_BASE_REF`, `JIG_GIT_LOG` (test seam), `RUN_URL`. The packed check strips and resets many variables for its child processes; the real check sets `HOME`, `PI_CODING_AGENT_DIR` and `BROWSER`, and removes `AWS_PROFILE`, `AWS_DEFAULT_PROFILE` and `JIG_BEDROCK_PROFILE`.
- **Git hooks:** none installed by this directory.

## Verification

- Run: `npm test`. The tests that cover these scripts are `test/ci-scripts.test.ts`, `test/commit-emails.test.ts`, `test/process.test.ts`, `test/publish-workflow.test.ts`, `test/real-check-discovery.test.ts` (the discovery check against the fake AWS), `test/release-notes.test.ts` and `test/scan-paths.test.ts`. `real-check-messages.mjs` has no test and needs a real AWS profile, or `--dry-run`.
- Then run: `npm run scan`, `npm run check:emails` and `npm run check:packed`.
