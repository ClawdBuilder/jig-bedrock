# jig-bedrock: Claude on AWS Bedrock for Pi

A Pi provider for Claude on AWS Bedrock. It discovers the Claude inference profiles your account can use. A default
install uses Converse for AWS-defined (system) profiles and the Messages route for application inference profiles; the
`api` setting can force either route. It works in plain Pi; when [Jig](https://github.com/ClawdBuilder/jig) is installed
it also reads `bedrock` settings from `jig.json` and uses Jig's records and footer, but Jig is not required.

Pi's built-in Bedrock provider uses Converse only, has a fixed model list, and has no profile discovery, SSO repair or
budget footer. This package adds the Messages route with SigV4, discovery in three modes, repair through `aws sso login`,
and an optional spend line.

Installing this package replaces Pi's built-in Bedrock model list with the models discovered here, so Pi's built-in
Bedrock models, including the non-Claude ones, are not shown while it is installed. A Bedrock API key (bearer token) is
not supported yet; use an AWS profile.

## Install

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Requirements: Node 22.19 or later, Pi 1.5 or later, and the AWS CLI v2 for discovery. You need an AWS profile the CLI can
use; **SSO is one option, not a requirement**. Linux and WSL2 are supported. macOS is expected to work but is not
tested; reports and fixes are welcome. Native Windows is not supported ([why](docs/settings.md#windows)).

Run `/bedrock-doctor` after installing; it checks Node, the AWS CLI, `bash`, `jq` and the optional usage program without
calling AWS.

## Settings

With Jig, add a `bedrock` section to `jig.json`. A plain Pi install has no `jig.json`: put the same keys in
`~/.pi/agent/bedrock.json`. Nothing is required: `/login` → Sign in with an API key → Amazon Bedrock
(jig-bedrock) asks how you sign in (an existing profile, an SSO sign-in, a new SSO or role profile, access keys, or
the ambient credential chain), checks the profile with AWS, and saves the discovery choice and regions. A new profile
shows its exact lines first and is appended to `~/.aws/config` only after you confirm. You can also set
`bedrock.profile` yourself.

```json
{ "bedrock": { "profile": "my-aws-profile", "regions": ["us-east-1"] } }
```

| Setting   | Default         | Meaning                                                                                        |
| --------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `profile` | unset           | The AWS profile for discovery and requests; `/login` chooses it, and this setting overrides it |
| `regions` | `["us-east-1"]` | Where to look for profiles                                                                     |
| `team`    | none            | Your `Team` tag value: narrows discovery to tagged profiles                                    |
| `api`     | `messages`      | `messages` (cache-friendly) or `converse`                                                      |

A profile chosen at `/login` is Pi's credential for this provider: the record holds the profile name, never a key. The
same flow saves the discovery mode and regions to `bedrock.json`; it never writes the profile there.

With no tag settings, discovery lists every AWS-defined cross-region Claude profile in `regions`. `team` or
`tagKey`/`tagValue` narrows it to tagged application profiles, and `profiles` names profiles explicitly. A successful
catalog is cached for 24 hours; `/bedrock-refresh` forces a new run.

Sign-in is repaired when an SSO session has expired: the provider checks at start and retries once before a response,
and `/aws-login` starts the login. `signInAtStart: false` leaves it to the failing request. Requests use the AWS SDK's
credential chain; discovery uses the AWS CLI, so the profile must work in both.

Every setting, the three discovery modes and the environment variables: [Settings](docs/settings.md).

## Routes and model ids

A default install uses **Converse** for AWS-defined (system) profiles and the **Messages** route for application
inference profiles. `api: "messages"` only applies the Messages route where the profile kind supports it; `api:
"converse"` puts every model on Converse.

AWS-defined discovery can show two models for one foundation model, for example `claude-haiku-4-5` and
`claude-haiku-4-5--us-east-1--global.anthropic.claude-haiku-4-5-20251001-v1:0`. The **short id** is the preferred
system profile: the geography prefix that matches your first configured region (`us`, `eu`, `apac`, `jp`, `au`,
`us-gov`), then `global`, then the other regions in the order you configured them. The **long form** is another system
profile for the same model:
`<slug>--<region>--<profile id>`. Both are separate AWS inference profiles with their own routing and price, so both
stay in `/model`.

## Commands

The footer and `/bedrock-usage` read an executable `usage` in `usageDir`; without one, models and sign-in still work.

| Command                   | What it does                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `/bedrock-refresh`        | Refresh the discovered profiles                                                          |
| `/bedrock-usage [period]` | Show the usage program's daily, weekly or monthly figures (default monthly)              |
| `/bedrock-stats`          | Compare local Pi session usage with the usage program's monthly figure                   |
| `/bedrock-profiles`       | Show the discovered profiles, the mode and catalog age, and why a profile is unavailable |
| `/aws-login`              | Renew the configured profile's IAM Identity Center session; it checks the profile first  |
| `/bedrock-doctor`         | Probe Node, AWS CLI, bash, jq and the optional usage program; it does not call AWS       |

## IAM

The AWS CLI and every signed request need these actions:

| Action                                  | Needed for                                  | Resource                                                   |
| --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `sts:GetCallerIdentity`                 | The account check before discovery          | `*`                                                        |
| `bedrock:ListInferenceProfiles`         | System mode: the profile list               | `*`                                                        |
| `tag:GetResources`                      | Tag mode: profiles by tag                   | `*`                                                        |
| `bedrock:GetInferenceProfile`           | Tag and explicit modes: one profile's model | The inference-profile ARN                                  |
| `bedrock:InvokeModelWithResponseStream` | Requests, on both routes                    | The profile ARN and each foundation-model ARN it routes to |

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
