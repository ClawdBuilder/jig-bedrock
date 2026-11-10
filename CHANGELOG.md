# Changelog

## [Unreleased]

### Fixed

- On the Messages route, a model whose Pi Anthropic entry disables temperature no longer sends one: Sonnet 5.5, Haiku 5.5, Opus 4.7/4.8/5.x and Sonnet 5 (in Pi 1.5.1) are affected; older Claude models keep temperature.
- Adaptive thinking on the Messages route now follows Pi's own model list, not only the 5.5 family: Opus 4.6 to 4.8 and 5.x, Sonnet 4.6 and 5.x, Haiku 5.5 and Fable 5 get their flags from Pi's Anthropic entries.
- On the Messages route, Sonnet 5.5 and the other adaptive models now send the same thinking and mid-conversation settings Pi's own Anthropic provider sends for the same model, including `thinking.block_binding.prefix_mismatch_behavior = "drop_block"` (the setting Anthropic's error names for a changed tool list) and the deferred tool placeholder that keeps the tools-list prefix stable.
- When Jig's `bedrock` settings arrive after jig-bedrock loads, a catalog cache that matches the new profile and tag is used first, with no AWS call and no wait even when the AWS CLI is slow. A slow discovery now says so instead of reporting the saved model as unavailable.
- A failed model refresh gives one plain notice, whether it came from `/bedrock-refresh`, the start-up refresh or `/login`: a timeout says AWS is slow, an unreachable AWS says to check network access, and a saved model that is really gone is reported at session start.
- Discovery accepts a global profile whose foundation-model address has no region, and profile ids with a version suffix such as `-v1:0`.
- One profile that cannot be read is recorded for that profile and the other profiles still load. A failed refresh names the step and a plain reason, without an AWS account id.
- The result notice names at most three profiles by their short id, then points to `/bedrock-profiles` for the rest, instead of listing every rejected address.

### Changed

- AWS-defined discovery builds the catalog from the `list-inference-profiles` rows themselves: one identity call and one listing call per region, instead of one `get-inference-profile` per profile. The real 33-profile run took 47 seconds; the same account should now take under 10 seconds per region. Tag and explicit discovery still read at most four profiles at once.
- A listing larger than the 1 MiB per-call limit (8 MiB in total) shows “Could not list inference profiles: the listing is larger than the 1 MiB limit.” and leaves the previous catalog in place.

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
