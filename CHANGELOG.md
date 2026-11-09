# Changelog

## [Unreleased]

### Fixed

- `/aws-login` checks that the profile exists and is an IAM Identity Center (SSO) profile before starting the AWS CLI, and the automatic repair after an expired session uses the same check; a missing or key-based profile gets a plain message instead of a failed login.
- After `/login` chooses a profile, jig-bedrock starts discovery itself, says “Loading Bedrock models…”, and then either names the model count or says what to run next; the profile listing now shows “Looking up your AWS profiles…” while the CLI answers.
- With no AWS profile, the start-up notice says which setting is missing and points to `/login` instead of sending you to `/aws-login`; `/aws-login` no longer tries the placeholder `my-bedrock-profile`.
- `/bedrock-doctor` names the AWS profile and where it came from, the discovery mode and the regions, and marks what is missing (with plain words when the terminal cannot show the symbols).
- `/login` on Amazon Bedrock (jig-bedrock) no longer offers a bearer token and never asks for a secret: its one method is an AWS profile, stored as `env.AWS_PROFILE` with no key.
- `docs/` is part of the npm package, so the README's More detail links work after an install.

### Changed

- The profile comes from `bedrock.profile`, `JIG_BEDROCK_PROFILE`, the profile chosen at `/login`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, or the default profile when `aws configure list-profiles` lists it; with none, the ambient AWS credential chain is used. A profile that does not exist resolves to no models instead of models that cannot answer.
- Each release has a GitHub release page with that version's changelog.

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
