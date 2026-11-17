# jig-bedrock Blueprint

## System Overview

jig-bedrock is a public Pi package (`@clawdbuilder/jig-bedrock`) that turns AWS Bedrock inference profiles into Pi models. A person signs in with an AWS profile; the package finds the inference profiles that profile can call, lists them in `/model`, signs each request itself, keeps the prompt cache, renews an expired SSO sign-in, and shows spend. It is human-facing in [README.md](./README.md) and the pages under [docs](./docs/how-it-works.md); this file is the agent-facing map of the same system. The words used throughout (AWS profile, inference profile, model, route, catalog) are defined in [How it works](./docs/how-it-works.md).

The life of a session:

1. **Pi starts the package.** `index.ts` hands over to `src/`. Settings are read and the providers (one per preset, or the one plain provider) and the `/bedrock` commands are registered. Nothing waits for AWS and nothing touches the network.
2. **A session starts.** The AWS profile is chosen, the saved catalog is read, and a stale catalog refreshes in the background.
3. **A request.** The route (Messages or Converse) is chosen per model, the request is signed with the AWS profile's credentials, and an expired SSO sign-in is repaired once, then the request is sent again.
4. **A reply ends.** Spend is recorded, the footer updates, and a budget notice may appear.

## Local Interface & Invariants

- **`index.ts`** is the Pi extension entry: `export { default } from "./src/index.ts"`. `package.json` points `pi.extensions` at it. It holds no logic of its own.
- **`package.json`** is ESM (`"type": "module"`), needs Node 22.19 or later, and publishes only `index.ts`, `src/**` (but not `src/EGM.md`), `bin/**`, `docs/**`, `CHANGELOG.md`, `README.md` and `LICENSE`.
- The Pi peer range stays open (`*`) while the Pi dev dependencies stay pinned to one exact version (`test/packaged-links.test.ts`).
- No side effect at import: loading `index.ts` registers and returns; see the [src contract](./src/EGM.md).

## Subdirectories & System Boundaries

- src: [./src/EGM.md](./src/EGM.md) - the whole extension: settings, discovery, catalog and routes, request signing, SSO repair, prompt cache, spend, and the `/bedrock` commands.
- scripts: [./scripts/EGM.md](./scripts/EGM.md) - maintainer and CI tooling: the public-tree scan, commit-email check, packed-install check, release notes, Pi version installer, and manual real-AWS checks. Not published.
- docs: no code contract. The pages [how-it-works](./docs/how-it-works.md), [settings](./docs/settings.md), [contributing](./docs/contributing.md), [troubleshooting](./docs/troubleshooting.md) and [spend-command](./docs/spend-command.md) are tested against the code by `test/docs.test.ts`. `docs/img` and `docs/cover` hold the diagrams and the cover image.
- test: no code contract. The `*.test.ts` files, run by the Node test runner. `test/support/` holds the fake AWS, the fake Pi host and the fake WSL that every test uses instead of real AWS.
- bin: no code contract. `bin/windows-browser` opens an address in the Windows default browser from WSL; `src/wsl.ts` gives it to `aws sso login` as its `BROWSER`.

## Global Invariants

- **The repository is public.** No company name, account id, real AWS profile name or machine path appears anywhere in it; `npm run scan` enforces this, and a page that needs an example path uses `<user>`, `me`, `you` or `user`.
- **Tests never reach real AWS.** They use the fake AWS in `test/support/`, never run the real `aws` program, use no network, no sleep past a short wait and no real credentials, and never print or log credentials, tokens or authorization headers.
- **Four checks pass before work is called done:** `npm test`, `npm run check`, `npm run scan` and `npm run check:packed`. A "Done when" line is tried against a failing case, not only the happy one.
- **The pages stay true to the code.** Every setting in `src/config.ts` has a row in `docs/settings.md`, every `JIG_BEDROCK_` variable and every `/bedrock` sub-command a page names exists in `src/`, every link and image points at a published file, and "profile" is never used alone ("AWS profile" is the sign-in, "inference profile" is a model entry). `AGENTS.md` stays a short guide of 30 to 40 lines. All of this is checked by `test/docs.test.ts`.
- **No secret is asked for, stored or printed.** The package stores only an AWS profile name; credentials stay in the AWS credential chain.
- **Commits** are authored as `Jig Contributors <noreply@example.com>`, with an imperative subject and one concern per commit.
- **A setting and a command each change in several places together;** the steps are in the [src contract](./src/EGM.md#invariants) and in `AGENTS.md`.

## Global Side Effects

- **AWS.** Signed HTTPS calls to Bedrock (requests, inference-profile discovery) and STS from `src/`. Discovery only reads. Real AWS is reached only by the manual scripts in `scripts/` and by a person using the package.
- **The AWS CLI.** Started for the sign-in (`aws sso login`) and a few checks; the package never starts it for discovery or to read AWS profile names. (A program named by a profile's own `credential_process`, which may be the AWS CLI, is run by the AWS SDK credential chain whenever credentials are resolved.)
- **Local files.** The user's `bedrock.json` in Pi's agent folder; an append-only edit of the shared AWS config when a profile is added; the catalog and refusals under the cache root; spend lines, the debug log and the sign-in lock under the state or runtime folder. Details: [Settings](./docs/settings.md) and the [src contract](./src/EGM.md#side-effects).
- **npm and GitHub, in CI and releases only.** `scripts/` talks to the npm registry, a local fake registry, and GitHub through `gh`. Releases are described in [Contributing](./docs/contributing.md).
- **What ships.** `package.json` `files` publishes `src/**` except `src/EGM.md` (`!src/EGM.md`), so none of the `EGM.md` contracts are in the npm package; `scripts/` and `test/` are not either.

## System Verification

- Run: `npm test` (the Node test runner over `test/*.test.ts`).
- Then run: `npm run check` (`tsc` and `biome ci`), `npm run scan` (the public-tree scan) and `npm run check:packed` (pack, install into a stock Pi, and load the extension).
