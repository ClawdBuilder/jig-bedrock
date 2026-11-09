# jig-bedrock: Claude on AWS Bedrock for Pi

**Status: built.**

A Pi provider for Claude on AWS Bedrock. It discovers the Claude inference profiles your account can use, sends Claude
through Bedrock's Anthropic Messages route where possible, and falls back to Converse per model. It works in plain Pi;
when [Jig](https://github.com/ClawdBuilder/jig) is installed it also uses Jig's records and footer, but Jig is not
required.

Pi's built-in Bedrock provider uses Converse only, has a fixed model list, and has no profile discovery, SSO repair or
budget footer. This package adds the Messages route with SigV4, discovery in three modes, repair through `aws sso login`,
and an optional spend line.

## Install

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Requirements: Node 22.19 or later, Pi 1.5 or later, and the AWS CLI v2 for discovery. You need an AWS profile the CLI can
use; **SSO is one option, not a requirement**. Linux, WSL2 and macOS are supported; native Windows is not
([why](docs/settings.md#windows)).

Run `/bedrock-doctor` after installing; it checks Node, the AWS CLI, `bash`, `jq` and the optional usage program without
calling AWS.

## Settings

With Jig, add a `bedrock` section to `jig.json`. A plain Pi install has no `jig.json`: put the same keys in
`~/.pi/agent/bedrock.json`. Nothing is required: `/login` chooses the AWS profile (or set `bedrock.profile`).

```json
{ "bedrock": { "profile": "my-aws-profile", "regions": ["us-east-1"] } }
```

| Setting   | Default         | Meaning                                                                 |
| --------- | --------------- | ----------------------------------------------------------------------- |
| `profile` | unset           | The AWS profile for discovery, requests and sign-in; `/login` stores it |
| `regions` | `["us-east-1"]` | Where to look for profiles                                              |
| `team`    | none            | Your `Team` tag value: narrows discovery to tagged profiles             |
| `api`     | `messages`      | `messages` (cache-friendly) or `converse`                               |

A profile chosen at `/login` is Pi's credential for this provider: the record holds the profile name, never a key.

With no tag settings, discovery lists every AWS-defined cross-region Claude profile in `regions`. `team` or
`tagKey`/`tagValue` narrows it to tagged application profiles, and `profiles` names profiles explicitly. A successful
catalog is cached for 24 hours; `/bedrock-refresh` forces a new run.

Sign-in is repaired when an SSO session has expired: the provider checks at start and retries once before a response,
and `/aws-login` starts the login. `signInAtStart: false` leaves it to the failing request. Requests use the AWS SDK's
credential chain; discovery uses the AWS CLI, so the profile must work in both.

Every setting, the three discovery modes and the environment variables: [Settings](docs/settings.md).

## Commands

| Command                   | What it does                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `/bedrock-refresh`        | Refresh the discovered profiles                                                          |
| `/bedrock-usage [period]` | Show the usage program's daily, weekly or monthly figures (default monthly)              |
| `/bedrock-stats`          | Compare local Pi session usage with the usage program's monthly figure                   |
| `/bedrock-profiles`       | Show the discovered profiles, the mode and catalog age, and why a profile is unavailable |
| `/aws-login`              | Start the owning AWS CLI's `sso login` for the configured profile                        |
| `/bedrock-doctor`         | Probe Node, AWS CLI, bash, jq and the optional usage program; it does not call AWS       |

The footer and `/bedrock-usage` read an executable `usage` in `usageDir`; without one, models and sign-in still work.

## IAM

The AWS CLI and every signed request need these actions:

| Action                                  | Needed for                                 | Resource                                                   |
| --------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `sts:GetCallerIdentity`                 | The account check before discovery         | `*`                                                        |
| `bedrock:ListInferenceProfiles`         | System mode: the profile list              | `*`                                                        |
| `tag:GetResources`                      | Tag mode: profiles by tag                  | `*`                                                        |
| `bedrock:GetInferenceProfile`           | Every mode: one profile's foundation model | The inference-profile ARN                                  |
| `bedrock:InvokeModelWithResponseStream` | Requests, on both routes                   | The profile ARN and each foundation-model ARN it routes to |

Every request streams. Messages goes to Bedrock's Anthropic route, and Converse uses the SDK's `ConverseStream`, which
`bedrock:InvokeModelWithResponseStream` authorizes; `bedrock:InvokeModel` is not needed. No `ListFoundationModels` or
`GetFoundationModel` permission is needed: the code reads the foundation model from the profile's ARN.

An inference profile must allow the profile **and** the foundation model in every region it routes to. AWS's
[inference-profile permissions][ip-iam] say the same.

## More detail

- [Settings](docs/settings.md): read before you change one; every field, the modes, credentials, environment.
- [How it works](docs/how-it-works.md): read when a profile is missing; discovery, routes, model ids, the footer.
- [Not verified](docs/not-verified.md): read before you rely on it; what has run against real AWS, what the tests fake.

## Licence

MIT.

[ip-iam]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
