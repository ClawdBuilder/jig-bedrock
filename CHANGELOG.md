# Changelog

## [Unreleased]

## [0.3.3] - 2026-11-12

- The README and pages say which models are listed and which keep the prompt cache.

## [0.3.2] - 2026-11-12

- The README and pages explain with diagrams and short tables.

## [0.3.1] - 2026-11-11

- Opening `/model` refreshes the Bedrock list when its cache is older than 24 hours, so a new inference profile appears without `/bedrock refresh`; if AWS fails, Pi says it is showing cached models.

## [0.3.0] - 2026-11-11

**Updating from 0.2.5.** The settings file moved from the `bedrock` section of `jig.json` to `bedrock.json`. Run `/bedrock migrate` once; it copies the section and leaves the old file alone. The old command names (`/bedrock-doctor`, `/bedrock-usage`, `/bedrock-stats`, `/bedrock-profiles`, `/bedrock-refresh`, `/aws-login`) still work for this release only and name their replacement.

### Added

- One `/bedrock` command with `status`, `doctor [offline|call]`, `models`, `refresh`, `login`, `usage`, `budget`, `settings`, `set`, `unset`, `migrate` and `help`, argument completions and closest-name suggestions.
- `/bedrock doctor` ends with `Bedrock is ready.` or a plain problem count and one `Next:`; `doctor offline` skips AWS, and `doctor call` sends one tiny request after saying that it costs a fraction of a cent.
- A local spend record, `/bedrock usage [day|week|month]` per model with tokens and cache share, and `/bedrock budget [amount|off]` in Pi's footer. Amounts under one cent print `<$0.01`, and the budget is a display figure, not an AWS limit.
- `spendCommand` can supply this month's spend from a command you name; it runs without a shell at most every ten minutes.
- A debug log, off by default: `"debug": true` in `bedrock.json` or `JIG_BEDROCK_DEBUG=1` writes a private request log with model, region, route, status, AWS request id, duration and token counts, never prompts, replies or credentials.
- `converseModels` and `messagesModels` let you keep a model on Converse or force Messages. A model on both lists is an error.
- A first-session notice in a new agent folder: `Bedrock: run /login, choose Amazon Bedrock (jig-bedrock), then /model.` It is shown once.

### Changed

- Claude models now use the Messages route when Pi lists mid-conversation tool changes for them; the other models use Converse. In the measured run of 2026-11-10 (about 34,000 tokens), the first request after a tool load read 34,216 tokens from the cache on Messages and wrote 275, where Converse wrote 34,321; the session cost $0.0051 against $0.0090. The same rule applies to AWS-defined and application inference profiles.
- Model menu names are short: `Claude Sonnet 5.5`, `Claude Sonnet 5.5 · global`, and an application profile's own name.
- AWS-defined profiles now have short second ids such as `claude-haiku-4-5-global`; the old long id still selects the same profile.
- `/login` asks for "inference profiles" and "AWS profile" instead of bare "profiles", and signing in loads the models so `/model` can list them at once.
- An automatically picked AWS profile that fails shows only the once-per-folder `/login` notice. A profile you chose names the fault: no credentials, an expired sign-in, or a refusal by AWS.
- `NO_COLOR` removes colour only; the ✓/✗/– marks stay unless `TERM=dumb` or the locale is not UTF-8.
- Budgets start at $1, settings are validated before they are written, and a `Next:` line appears only when there is an action.
- AWS profile names are read from the AWS config and credentials files instead of starting the AWS CLI at every Pi start.
- With `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, the default profile or environment credentials already set, a cached model list made for that profile is available at Pi start, so `--model`, `--list-models` and print mode see it.
- A start-up refresh that finds no change says nothing. When the list really changes it says one line, and if the selected model is gone it says which model and asks you to choose another with `/model`.
- The catalog cache follows `XDG_CACHE_HOME` and works when your cache or home folder is a link.
- This package sits beside Pi's built-in Bedrock provider; its models, sign-in and Bedrock API key keep working.
- A `team` value from 0.2.x is still read once as the tag pair (`tagKey: "Team"`, `tagValue: <team>`, `activeTagKey: "Active"`, `activeTagValue: "true"`).

### Fixed

- A real `AWS_BEARER_TOKEN_BEDROCK` no longer reaches a Converse request: the package signs with your AWS profile and restores the variable afterwards for Pi's built-in provider. The Messages route already signs its requests and removes the client's key headers.
- Application inference profiles no longer fail with a 400 or 404 after a tool is loaded mid-session; they follow the same route rule as AWS-defined profiles.
- Writing a new SSO profile from `/login` keeps a separate timestamped backup, writes through a symbolic link instead of replacing it, and takes a lock so two Pi processes do not write at once.
- The catalog cache and the SSO runtime folder work when `~/.cache`, `~/.local` or `~/.local/state` is a link, as on macOS.
- A config file with a link in its path is no longer ignored, and a missing or unusable profile is named in plain words instead of "unexpected answer".

### Removed

- The old usage program and its cache and Bash/jq requirements; `usageDir` and `JIG_BEDROCK_USAGE_DIR` are gone.
- The Jig settings section, optional Jig API, custom Jig theme/lens events and Jig development dependency.
- Starting `aws configure list-profiles` at Pi start-up, in `/login` and in `/bedrock doctor`; profile names are read from files.
- The startup warning about unusable profiles; they are listed by `/bedrock models` and counted by `/bedrock status`.

### Development

- Tests, CI and scripts: CI runs the oldest and newest supported Pi, the packed-install check runs the whole command screens, and macOS is covered. Tests no longer leave temporary folders behind.

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
