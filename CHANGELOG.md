# Changelog

## [0.2.0] - 2026-11-08

### Added

- Inference-profile discovery has three modes. With no tag settings it lists AWS-defined cross-region Claude profiles
  (`SYSTEM_DEFINED`) in every configured region; `tagKey`/`tagValue` filters application profiles by any tag, with `team`
  still accepted as the value of the `Team` tag; `profiles` reads an explicit list of ARNs or profile ids.
- `activeTagKey`/`activeTagValue` are optional. Existing `team` settings still require `Active=true`, so they see no change.
- Each mode has its own IAM requirements and the README has the table.
- Model ids stay the slug of the model name; when a system and an application profile resolve to the same model, the
  system profile keeps the bare id and the application profile gets the region/profile suffix.

### Changed

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
