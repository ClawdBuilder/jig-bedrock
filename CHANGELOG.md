# Changelog

## [Unreleased]

### Added

- A local spend record: one private JSONL line per Bedrock reply under the user's state folder, with the month, session, short model id, region, route, token counts, Pi's cost and a priced flag. Earlier replies in this agent's session files are imported once, bounded and marked.
- `/bedrock usage [day|week|month]` and `/bedrock budget [amount|off]`; `/bedrock-usage` and `/bedrock-stats` call the same code. The footer shows the month's local spend and budget, with warning/error colours; the budget notices are once per threshold per month per machine.
- `spendCommand` can supply this month's spend from a command the user names; it runs without a shell, at most every ten minutes, and its JSON contract is documented with an example.
- `converseModels` and `messagesModels` settings: short model ids (for example `claude-opus-5`) that stay on Converse, and short model ids that go on Messages for a model newer than the installed Pi knows. A model on both lists is an error.
- `routeOf` in `src/catalog.ts` answers which route a model uses and why, in a few words ("Pi lists tool changes", "not on the Messages route", "your setting", "this Pi does not know the model", "known exception"); the model list uses it, so there is one rule.
- `scripts/real-check-messages.mjs` takes a comma-separated list of models and a `--thinking high,off` list, runs one session per pair and prints one table (route, calls, thinking, tool call, the call after the tool load, cost, result). `--retention long` sets `PI_CACHE_RETENTION`.

### Changed

- The usage program, its cache and its Bash/jq requirements are gone; `usageDir`/`JIG_BEDROCK_USAGE_DIR` are not settings, and an old `usageDir` key gets the unknown-key warning.
- Prices come from Pi's model registry. A model with no price is still listed, marked no price, and its replies count as unpriced.

- The package stands alone: `bedrock.json` and the `JIG_BEDROCK_*` environment are the only settings sources; the Jig settings section, the optional Jig API, the custom `jig-theme`/`jig-lens` events and the Jig development dependency are gone.
- `tagKey` and `tagValue` are the generic tag filter; a 0.2.x `team` value is still read once as `tagKey: "Team"`, `tagValue: <team>`, `activeTagKey: "Active"`, `activeTagValue: "true"`.
- `signInAtStart` now defaults to false; a browser is not opened because Pi started.
- This package sits beside Pi's built-in Amazon Bedrock provider instead of hiding its models. An AWS profile or SSO signs in this package; a Bedrock API key is used through Pi's built-in provider.
- A reply is recorded as `jig-bedrock/<short model id>`, while the inference-profile ARN goes on the wire. Sessions written by 0.2.x with the built-in provider and an ARN resume on the same model; built-in sessions with a plain id are left alone.
- A one-release migration reads a 0.2.x `jig.json` only to show one notice and copy its `bedrock` section to `bedrock.json` through `/bedrock migrate`; the copy is private and never overwrites an existing file.
- The subagent-child environment check and the remaining internal names were removed; the scan still covers the public tree.
- The AWS SDK's credential chain (`@aws-sdk/credential-provider-node`) is now this package's own dependency, installed with it, instead of being looked up in Pi's install folder. A new Pi that moves or drops that dependency no longer breaks sign-in checks or signed requests; the install is about 5 MB larger. `PI_HOST_DIR` is no longer read.
- **Route by model.** A Claude model uses the Messages route (which keeps the prompt cache when a tool is loaded in the middle of a session) when Pi's own Anthropic entry for it lists mid-conversation tool changes; every other model uses Converse. The rule is the same for AWS-defined and application profiles; AWS-defined profiles are no longer kept on Converse for being AWS-defined. On the real runs of 2026-11-10 (a prompt of about 34,000 tokens), the first request after a tool load read 34,216 tokens from the cache on Messages and wrote 275, where Converse wrote 34,321 (a session cost of $0.0051 against $0.0090). That holds today for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Opus 4.8. Pi lists the flag for the Fable models too, so they use Messages, but the real run could not test them: an account data-retention setting refused them on both routes. Sonnet 5, Opus 4.7, Opus 4.6, Sonnet 4.6 and Haiku 4.5 return a 400 on Messages as soon as a tool is loaded mid-session, and Opus 4.5, Sonnet 4.5 and Opus 4.1 return a 404, so they use Converse. Opus 5 has the flag but returned a 400 on Messages with thinking high, so it uses Converse until that is understood. A model the installed Pi does not list uses Converse.
- The Messages route no longer claims mid-conversation system messages and tool changes for every model; it copies them from Pi's entry, as it already did for the effort flag.
- On the Messages route a model declares only the 5-minute cache lifetime. The route does not send the 1-hour checkpoint (Pi's `ttl: "1h"` stays off for it), so the model-switch notice prices a Messages model's cache write at the 5-minute rate and expects its cache to expire after 5 minutes, whatever `PI_CACHE_RETENTION` says; Pi's cache warming no longer plans for an hour on those models. Converse models keep both lifetimes.

### Fixed

- Converse requests no longer use an ambient `AWS_BEARER_TOKEN_BEDROCK`: Pi's Converse client reads it through `getProviderEnvValue`, where an empty scoped value falls back to `process.env`. The package hides that variable only while its own Converse request is in flight, signs with the configured AWS profile, and restores the variable on the response or stream end, so the built-in provider still sees it. The Messages signed fetch already removes `Authorization` and signs with SigV4; a real HTTP-layer test covers both routes.
- Adding a profile to `~/.aws/config` from `/login` now keeps a separate backup for each write, named with the time (for example `config.jig-bedrock-backup-20261110T171500Z`), instead of replacing one backup each time. The five newest are kept and older ones this package made are deleted; no other file is touched. The old `config.jig-bedrock.bak` is left where it is.
- A config file that is a symbolic link (for example into a dotfiles folder) is written through: its target gets the new profile and the link stays a link, where before it was replaced by a plain file.
- Two Pi processes can no longer write the config at the same moment: a lock file beside it is held during the write, and a second writer is told "Another program is changing <file>; try again." A lock older than 30 seconds is treated as left by a crashed writer and taken over.
- Application profiles of Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.7, Opus 4.6, Opus 4.5, Opus 4.1 and Haiku 4.5 (0.2.4 and 0.2.5 sent every application profile to Messages) no longer fail with a 400 or 404 once a tool is loaded mid-session; they use Converse.
- `scripts/real-check-messages.mjs --team` wrote `team` together with `tagKey` and `tagValue`, which the settings reject; it writes the tag pair only.

### Development

- CI now runs the tests against the oldest supported Pi (1.5.0) and the newest published one, installs the packed tarball into a stock Pi with its own `pi install npm:` and checks in rpc mode that the extension loads (`npm run check:packed`), and runs the type, style and unit checks on macOS. `ci-ok` waits for all of them.
- The tests use the real path of the system temporary folder, so they pass where it is a link (macOS), and read Pi's prompt-cache lifetime function from `pi-ai` when Pi 1.5.2 or later exports it there.

## [0.2.5] - 2026-11-10

Faster discovery on real AWS, the same thinking settings as Pi's own Anthropic provider, and a clearer public package.

### Fixed

- On the Messages route, a model whose Pi Anthropic entry disables temperature no longer sends one: Sonnet 5.5, Haiku 5.5, Opus 4.7/4.8/5.x and Sonnet 5 (in Pi 1.5.1) are affected; older Claude models keep temperature.
- Adaptive thinking on the Messages route now follows Pi's own model list, not only the 5.5 family: Opus 4.6 to 4.8 and 5.x, Sonnet 4.6 and 5.x, Haiku 5.5 and Fable 5 get their flags from Pi's Anthropic entries.
- On the Messages route, Sonnet 5.5 and the other adaptive models now send the same thinking and mid-conversation settings Pi's own Anthropic provider sends for the same model, including `thinking.block_binding.prefix_mismatch_behavior = "drop_block"` (the setting Anthropic's error names for a changed tool list) and the deferred tool placeholder that keeps the tools-list prefix stable.
- When Jig's `bedrock` settings arrive after jig-bedrock loads, a catalog cache that matches the new profile and tag is used first, with no AWS call and no wait even when the AWS CLI is slow. A slow discovery now says so instead of reporting the saved model as unavailable.
- A failed model refresh gives one plain notice, whether it came from `/bedrock-refresh`, the start-up refresh or `/login`: a timeout says AWS is slow, an unreachable AWS says to check network access, and a saved model that is really gone is reported at session start.
- Discovery accepts a global profile whose foundation-model address has no region, and profile ids with a version suffix such as `-v1:0`.
- One profile that cannot be read is recorded for that profile and the other profiles still load. A failed refresh names the step and a plain reason, without an AWS account id.
- The result notice names at most three profiles by their short id, then points to `/bedrock-profiles` for the rest, instead of listing every rejected address.
- A failed Bedrock request now keeps the AWS error name, message, HTTP status and request id instead of a generic sentence.
- On the Messages route, an expired SSO session is repaired like a Converse one: a marked local 401 carries the sign-in wording and allows the one replay, instead of surfacing Pi's “Connection error.”.
- An unknown key in `bedrock.json` is ignored with a warning naming the key and file, while a bad value for a known key still stops the provider and names the field. A `bedrock.json` that is not valid JSON is reported instead of being silently ignored.

### Changed

- AWS-defined discovery builds the catalog from the `list-inference-profiles` rows themselves: one identity call and one listing call per region, instead of one `get-inference-profile` per profile. The real 33-profile run took 47 seconds; the same account should now take under 10 seconds per region. Tag and explicit discovery still read at most four profiles at once.
- A listing larger than the 1 MiB per-call limit (8 MiB in total) shows “Could not list inference profiles: the listing is larger than the 1 MiB limit.” and leaves the previous catalog in place.
- The Pi peer range is `*` instead of an exact version, so a Pi update is not blocked; the development pins stay exact.
- `CHANGELOG.md` is in the published package, so Pi can show update notes.
- The README explains the default routes (Converse for AWS-defined profiles, Messages for application profiles), the short and long model ids for the same AWS-defined model, that installing hides Pi's built-in Bedrock models, and that a Bedrock API key is not supported yet.
- The private-word scan in CI receives the repository secret and prints only the file and line; a Pi without Pi's Anthropic registry path falls back to the model-name pattern instead of stopping the provider, and the leftover internal wording and comments are gone.

## [0.2.4] - 2026-11-10

Choose how you sign in to AWS from `/login`, and create an SSO or role profile without leaving Pi.

### Added

- `/login` now asks how you sign in to AWS: an existing profile, an IAM Identity Center (SSO) sign-in, an SSO profile created there, access keys or a role set up in the AWS CLI, a role profile created there, or the ambient credential chain. It refuses a Bedrock API key and names the alternatives, checks the profile with `aws sts get-caller-identity`, and saves the discovery mode and regions it asks for. Access-key and role instructions stay on screen until you say the profile exists.
- Creating an SSO or role profile shows the exact lines first and writes only after you confirm. It respects `AWS_CONFIG_FILE`, keeps comments, unknown sections and the file mode, and leaves a backup.

### Changed

- The discovery choice and regions from `/login` are saved to `bedrock.json`, never the profile and never a secret. When Jig's `bedrock` section sets the same key, the login says which value wins.

## [0.2.3] - 2026-11-10

Sign in from `/login` with an AWS profile, clear first-run messages, and Jig in either install order.

### Fixed

- With no AWS profile, the start-up notice names what is missing and points to `/login`; `/aws-login` and the repair after an expired session check that the profile exists and is an IAM Identity Center (SSO) profile before starting a sign-in, and a missing or key-based profile gets a plain message.
- `/login` on Amazon Bedrock (jig-bedrock) offers an AWS profile only and never asks for a secret or stores a key. It says “Looking up your AWS profiles…” while the AWS CLI answers, then loads your models and tells you what it found.
- `/bedrock-doctor` names the AWS profile you use and where it came from, the discovery mode and the regions; missing pieces are marked, with plain words when the terminal cannot show the symbols.
- Jig's `bedrock` settings apply whichever extension loads first: the install order no longer changes the profile, and a jig-core that loads after jig-bedrock no longer asks for a reload.
- The README's `docs/` pages are included in the npm package.

### Changed

- The AWS profile comes from `bedrock.profile`, `JIG_BEDROCK_PROFILE`, the profile chosen at `/login`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, or the default profile when `aws configure list-profiles` lists it; with none, the ambient AWS credential chain is used. A profile that does not exist shows no models instead of models that cannot answer.
- Each release has a GitHub release page with that version's changelog.

### Internal

- The Jig integration keeps only the lookup half of Jig's client, and a test-only `@clawdbuilder/jig` dependency checks that the global symbols and the `config` calls still exist; it is not shipped.

## [0.2.2] - 2026-11-09

### Changed

- The README is 95 lines; the detail is in `docs/` (settings, how it works, not verified).
- Releases publish from CI with npm Trusted Publishing and provenance.

## [0.2.1] - 2026-11-08

### Fixed

- With `signInAtStart: false`, the start-up SSO check still runs read-only. An expired session now shows
  “Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh.” instead of staying silent.
- The saved-model warning says “for your profiles”, not “for this team”; the usage footer says it is not a total across
  profiles, not a team total.

## [0.2.0] - 2026-11-08

### Added

- Inference-profile discovery has three modes. With no tag settings it lists **every** AWS-defined cross-region Claude
  profile (`SYSTEM_DEFINED`) in your regions, including `global.` profiles, whose cost and data residency differ. A user
  who was "disabled" before now gets models. Narrow it with `profiles` or a tag; `tagKey`/`tagValue` filters application profiles by any tag, with `team`
  still accepted as the value of the `Team` tag; `profiles` reads an explicit list of ARNs or profile ids.
- `activeTagKey`/`activeTagValue` are optional. Existing `team` settings still require `Active=true`, so they see no change.
- Each mode has its own IAM requirements and the README has the table.
- Model ids stay the slug of the model name; when a system and an application profile resolve to the same model, the
  system profile keeps the bare id and the application profile gets the region/profile suffix.

### Changed

- A 0.1.2 catalog is reused once after the upgrade when team, profile and regions match; changing tag settings in the same
  step takes effect on `/bedrock-refresh`.
- `team` is no longer required. The default is now system-defined profiles, so a missing `team` no longer disables the
  provider.
- System-defined profiles use the Converse route because their ids are not application inference-profile ARNs.

All notable changes to `jig-bedrock` are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] - 2026-11-08

### Fixed

- The optional usage program now runs as `<usageDir>/usage --daily|--weekly|--monthly --output json`. It no longer receives
  an extra `usage` word or an `--aws-profile` flag; `AWS_PROFILE` and `BEDROCK_REGIONS` are in its environment. A
  two-line wrapper for a CLI that already has its own `usage` command is shown in the README.
- A stalled usage program now keeps its timeout alive even when nothing else is running. A stalled SSO check does the
  same, so both report a timeout instead of letting the process end with a pending promise.

## [0.1.1] - 2026-11-08

### Fixed

- A plain Pi install is told to add `team` to `~/.pi/agent/bedrock.json`; with Jig, the notice names both `jig.json` and
  that file. The README says the same.
- The README now explains how discovery, both request routes, credentials and permissions work.

## [0.1.0] - 2026-11-08

### Added

- The first public release: Claude on AWS Bedrock through application inference profiles, with the Anthropic Messages route
  and Converse, AWS tag discovery, SSO repair, and an optional budget footer.
