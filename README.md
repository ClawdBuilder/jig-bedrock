# jig-bedrock: Claude on AWS Bedrock for Pi

A Pi provider for Claude on AWS Bedrock. It discovers the application inference profiles your account can use, sends
Claude through Bedrock's Anthropic Messages route where possible, and falls back to Converse per model.

## The gap it fills

Pi's built-in Bedrock provider uses Converse only, has a fixed model list, and has no profile discovery, SSO repair or
budget footer. This package adds the Messages route with SigV4, discovery by an AWS tag, repair through `aws sso login`,
and an optional spend line. It works in plain Pi; when [Jig](https://github.com/ClawdBuilder/jig) is installed it also
uses Jig's records and footer, but Jig is not required.

## Install

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Requirements: Node 22.19 or later, Pi 1.5 or later, and the AWS CLI v2 for discovery. You need an AWS profile the CLI can
use; **SSO is one option, not a requirement**. Linux, WSL2 and macOS are supported; Windows is not, for the reason below.

Run `/bedrock-doctor` after installing; it checks Node, the AWS CLI, `bash`, `jq` and the optional usage program without
calling AWS.

## Minimum settings

With Jig, add a `bedrock` section to `jig.json` (or use the environment). Nothing is required: with no settings, the
provider lists AWS-defined cross-region Claude profiles in `regions`.

```json
{ "bedrock": { "regions": ["us-east-1"] } }
```

A plain Pi install has no `jig.json`: put the same keys in `~/.pi/agent/bedrock.json` (or in a `bedrock` object in that
file). With Jig, that file is read first and Jig's `bedrock` section is merged over it. A project's `jig.json` may set the
catalog keys, but `ssoLoginCommand`, `usageDir` and `browser` are read only from the user's file or the environment.

Three modes, chosen by the settings:

1. **System-defined (default).** No tag settings: lists AWS-defined cross-region Claude inference profiles with
   `ListInferenceProfiles --type-equals SYSTEM_DEFINED`.
2. **Tag filter.** `tagKey` and `tagValue` filter application profiles by any tag. `team` is a shorthand for
   `tagValue` with `tagKey` defaulting to `Team`. `activeTagKey`/`activeTagValue` are optional; when `team` is set and
   `activeTagKey` is not, `Active=true` is still required, so existing settings behave exactly as before.
3. **Explicit list.** `profiles` names ARNs or profile ids; each is read with `GetInferenceProfile` and no tag search runs.

| Setting                           | Default                                         | Meaning                                                                                            |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `team`                            | none                                            | Shorthand for `tagValue`; existing settings keep the `Active=true` filter                          |
| `tagKey`                          | `Team` when tagged                              | The tag key for mode 2                                                                             |
| `tagValue`                        | the value of `team`                             | The tag value for mode 2                                                                           |
| `activeTagKey` / `activeTagValue` | none                                            | Optional tag that marks a profile usable; `team` alone still defaults to `Active`/`true`           |
| `profiles`                        | none                                            | Mode 3: explicit inference-profile ARNs or ids                                                     |
| `profile`                         | `my-bedrock-profile`                            | The AWS profile for discovery, requests and sign-in                                                |
| `regions`                         | `["us-east-1"]`                                 | Where to look for profiles                                                                         |
| `usageDir`                        | `~/.local/share/usage-tool`                     | Optional directory holding an executable `usage` that prints the usage JSON; omit if you have none |
| `monthlyBudgetUsd`                | none                                            | A figure for the footer, not an AWS limit                                                          |
| `ssoLoginCommand`                 | `["aws","sso","login","--profile","{profile}"]` | The owning tool starts the sign-in; this package never handles a password or token                 |
| `signInAtStart`                   | `true`                                          | Refresh an expired SSO session when Pi starts                                                      |
| `browser`                         | WSL's Windows browser                           | Program that opens the sign-in address                                                             |
| `api`                             | `messages`                                      | `messages` (cache-friendly) or `converse`                                                          |

Environment: `JIG_BEDROCK_TEAM`, `JIG_BEDROCK_PROFILE`, `JIG_BEDROCK_REGIONS`, `JIG_BEDROCK_USAGE_DIR`,
`JIG_BEDROCK_TAG_KEY`, `JIG_BEDROCK_TAG_VALUE`. `PI_HOST_DIR` points at the Pi install when it is not beside `node`.
`PI_CACHE_RETENTION` sets Pi's own cache retention; the provider does not change it.

## How it works

`jig-bedrock` reads the `bedrock` settings once at Pi start. Discovery and requests happen later: on the first request,
when Pi starts an SSO check, or when you run a command.

### Discovery

Discovery runs the AWS CLI with the configured `profile` and `regions`. It always starts with
`aws sts get-caller-identity`. Then:

- **System:** `aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED`, paginated per region; only Claude
  profiles are kept, then `GetInferenceProfile` reads each one.
- **Tag:** `aws resourcegroupstaggingapi get-resources --resource-type-filters
  bedrock:application-inference-profile`, filtered by `tagKey`/`tagValue` and, only when configured, the active tag.
- **Explicit:** `GetInferenceProfile` for each `profiles` entry; no tag call and no system listing.

Only `ACTIVE` profiles are listed. Their foundation model is read from the profile's model ARN; the provider does not call
`GetFoundationModel`. A successful catalog is cached for **24 hours** in `~/.cache/jig-bedrock/catalog.json`, with private
permissions and an atomic rename. A changed account or settings discards it; `/bedrock-refresh` forces a new run.

### Routes

There are two routes to the same Claude models:

- **Messages.** Pi's Anthropic Messages client calls
  `https://bedrock-runtime.<region>.amazonaws.com/anthropic/v1/messages`. `bedrock-fetch.ts` removes the client's API-key
  headers and signs each request with SigV4 (`sigv4.ts`). The signature uses the credentials the AWS SDK resolves for the
  configured profile.
- **Converse.** Pi's Bedrock provider uses the AWS SDK's `ConverseStream` operation at the bedrock-runtime endpoint.

A profile is put on Messages only when `api` is `messages` (the default), it is an **application** inference profile, and
its foundation model is an Anthropic model. System-defined profile ids use Converse, because they are not application
inference-profile ARNs. Every other model uses Converse. `api: "converse"` puts every model on Converse. Both routes stream. On Messages the tools array stays
stable, so the prompt cache survives a tool change; on Converse a changed tool list rewrites it. The footer and usage
figures are the same.

A child agent (a Pi session with `PI_SUBAGENT_ID`, or the older `PI_SUBAGENT_CHILD=1`) skips the catalog refresh, the
usage program and its events, and the sign-in at start. The parent does those; the child still sends requests and reads
the parent's cached catalog.

## IAM

| Mode     | Discovery permissions                                          | Invoke                                                                                                   |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| System   | `bedrock:ListInferenceProfiles`, `bedrock:GetInferenceProfile` | `bedrock:InvokeModel*` on the profile and on each foundation model it routes to, in every routing region |
| Tag      | `tag:GetResources`, `bedrock:GetInferenceProfile`              | same                                                                                                     |
| Explicit | `bedrock:GetInferenceProfile`                                  | same                                                                                                     |

Add `sts:GetCallerIdentity` for the account check. For an AWS-defined cross-region profile the policy must allow the
profile **and** the foundation model in every region it routes to; AWS's [inference-profile permissions][ip-iam] say the
same. Application profiles additionally need the profile's own ARN. [ip-iam]:
https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html

## Credentials

Requests use the AWS SDK's default credential chain, loaded from Pi's install (`pi-host.ts` loads
`@aws-sdk/credential-provider-node`). Discovery is different: it runs the AWS CLI with `--profile`, so the configured
profile must be usable by the CLI as well as by the SDK.

| What you have                                | Requests       | Discovery                              | Sign-in repair                                       |
| -------------------------------------------- | -------------- | -------------------------------------- | ---------------------------------------------------- |
| SSO / IAM Identity Center                    | yes, SDK chain | yes, `--profile`                       | yes: checked at start, one retry before any response |
| Access keys in a profile                     | yes            | yes, `--profile`                       | no                                                   |
| Assume role in a profile                     | yes            | yes, `--profile`                       | no                                                   |
| `credential_process` in a profile            | yes            | yes, `--profile`                       | no                                                   |
| Web identity or instance role                | yes            | only through a profile the CLI can use | no                                                   |
| Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) | not supported  | no                                     | no                                                   |

Only the SSO path has been tested against real AWS. The other rows are supported by the SDK and CLI, but not by a real
run in this package.

For a Bedrock API key: `sso.ts`'s `profileFor` declines to choose an SSO profile when the bearer variable is set, so no
repair is attempted. With a configured profile, the request path clears that variable and refuses an explicit API key or
bearer token with `Unapproved Bedrock authentication scope`. The package does not fall back to API-key auth.

## AWS permissions

The profile used for discovery needs these actions:

- `sts:GetCallerIdentity` for the account id;
- `tag:GetResources` for the tagged inference profiles;
- `bedrock:GetInferenceProfile` for each profile.

The provider always streams: Messages uses Bedrock's Anthropic Messages route, and Converse uses the SDK's
`ConverseStream` operation. The request therefore needs:

- `bedrock:InvokeModelWithResponseStream` for both routes. The SDK's `ConverseStream` is authorized by this action, not by
  an action named after Converse.

`bedrock:InvokeModel` is not needed: this provider has no non-streaming call. If a future call adds one, it needs that
action too.

For an application inference profile, the policy must allow the action on the profile's ARN **and** on every foundation
model ARN the profile routes to.

No `List` or `GetFoundationModel` permission is needed: the code gets the foundation model from the profile's ARN.

## Why not Windows

The SSO lock needs a POSIX owner and private `0700` directory (`ssoRuntime` in `src/login.ts` checks `process.getuid` and
mode bits), and the no-browser fallback is the WSL-only `bin/windows-browser` shell script. Native Windows has neither.

## Commands

| Command                   | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `/bedrock-refresh`        | Refresh the discovered profiles                                                    |
| `/bedrock-usage [period]` | Show the usage program's daily, weekly or monthly figures                          |
| `/bedrock-stats`          | Show the same cached figures as a short line                                       |
| `/bedrock-profiles`       | List the discovered profiles and why any are unavailable                           |
| `/aws-login`              | Start the owning AWS CLI's `sso login` for the configured profile                  |
| `/bedrock-doctor`         | Probe Node, AWS CLI, bash, jq and the optional usage program; it does not call AWS |

The footer and `/bedrock-usage` read an executable named `usage` in `usageDir`; it is called with `--daily`,
`--weekly` or `--monthly` and `--output json`, and prints the spend as JSON. It receives `AWS_PROFILE` and
`BEDROCK_REGIONS` in its environment.

If your usage CLI's own command is `usage-cli`, put this two-line wrapper at
`~/.local/share/usage-tool/usage` and make it executable:

```sh
#!/bin/sh
exec usage-cli usage "$@"
```

## Tests

```sh
npm test
npm run check
npm run scan
```

WSL uses `bin/windows-browser` when `browser` is unset, so the sign-in opens on Windows.

Real-AWS tests are manual and need the user's approval; unit tests use recorded shapes and a fake CLI.

## Licence

MIT.

## Not verified against real AWS

- The exact Messages behaviour for a system-defined profile id (this package sends those through Converse).
- The response shapes of `ListInferenceProfiles` pagination and system-profile model ARNs, which the tests fake from
  AWS documentation.
- IAM policy evaluation for cross-region profile plus foundation-model permissions in every routing region.
- Pricing and model metadata for system-defined profiles come from Pi's registry; no live `GetFoundationModel` call is made.
