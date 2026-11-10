# jig-bedrock: Claude on AWS Bedrock for Pi

A Pi provider for Claude on AWS Bedrock. It discovers the Claude inference profiles your account can use. A default
install uses Converse for AWS-defined (system) profiles and the Messages route for application inference profiles; the
`api` setting can force either route. It reads its settings from `~/.pi/agent/bedrock.json` and the `JIG_BEDROCK_*`
environment; nothing else is required.

Pi's built-in Bedrock provider uses Converse only, has a fixed model list, and has no profile discovery, SSO repair or
budget footer. This package adds the Messages route with SigV4, discovery in three modes, repair through `aws sso login`,
and a local spend record with an optional display budget.

This package sits beside Pi's built-in Bedrock provider: both model lists appear in `/model`, and the built-in provider
keeps its API-key sign-in and its own models. This package uses an AWS profile for its models; an ambient
`AWS_BEARER_TOKEN_BEDROCK` is ignored for them. Use Pi's built-in provider when you sign in with a Bedrock API key.

## Install

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Requirements: Node 22.19 or later, Pi 1.5 or later, and the AWS CLI v2 for discovery. You need an AWS profile the CLI can
use; **SSO is one option, not a requirement**. Linux and WSL2 are supported. macOS is expected to work but is not
tested; reports and fixes are welcome. Native Windows is not supported ([why](docs/settings.md#windows)).

Run `/bedrock-doctor` after installing; it checks Node and the AWS CLI without calling AWS.

## Settings

Put the keys in `~/.pi/agent/bedrock.json`; a file that wraps them in a `bedrock` object is still read. Nothing is required: `/login` → Sign in with an API key → Amazon Bedrock
(jig-bedrock) asks how you sign in (an existing profile, an SSO sign-in, a new SSO or role profile, access keys, or
the ambient credential chain), checks the profile with AWS, and saves the discovery choice and regions. A new profile
shows its exact lines first and is appended to `~/.aws/config` only after you confirm. You can also set
`bedrock.profile` yourself.

```json
{ "bedrock": { "profile": "my-aws-profile", "regions": ["us-east-1"] } }
```

| Setting            | Default         | Meaning                                                                                        |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------- |
| `profile`          | unset           | The AWS profile for discovery and requests; `/login` chooses it, and this setting overrides it |
| `regions`          | `["us-east-1"]` | Where to look for profiles                                                                     |
| `tagKey`           | none            | Tag mode: the tag name to filter on                                                            |
| `tagValue`         | none            | Tag mode: the tag value to filter on                                                           |
| `api`              | `messages`      | `messages` (cache-friendly) or `converse`                                                      |
| `monthlyBudgetUsd` | none            | Display budget for the footer and budget notices; not an AWS limit                             |
| `spendCommand`     | none            | Optional argv that prints this month's spend (see Spend command)                               |

A profile chosen at `/login` is Pi's credential for this provider: the record holds the profile name, never a key. The
same flow saves the discovery mode and regions to `bedrock.json`; it never writes the profile there.

If you used 0.2.x, your settings may be in the `bedrock` section of `jig.json`. The first session says so; `/bedrock
migrate` copies that section to `bedrock.json`, once, and leaves `jig.json` alone.

With no tag settings, discovery lists every AWS-defined cross-region Claude profile in `regions`.
`tagKey`/`tagValue` narrow it to tagged application profiles, and `profiles` names profiles explicitly. A 0.2.x `team`
value is still read once as the old short form; `/bedrock migrate` rewrites it. A successful
catalog is cached for 24 hours; `/bedrock-refresh` forces a new run.

Sign-in is repaired when an SSO session has expired: the provider checks at start and retries once before a response,
and `/aws-login` starts the login. `signInAtStart: false` (the default) leaves it to the failing request. Requests use the AWS SDK's
credential chain; discovery uses the AWS CLI, so the profile must work in both.

Every setting, the three discovery modes and the environment variables: [Settings](docs/settings.md).
The optional spend command and its ten-line example: [Spend command](docs/spend-command.md).
The first session in a new agent folder with no profile says once: “Bedrock: run /login, choose Amazon Bedrock
(jig-bedrock), then /model.”

## Routes and model ids

A default install uses **Converse** for AWS-defined (system) profiles and the **Messages** route for application
inference profiles. `api: "messages"` only applies the Messages route where the profile kind supports it; `api:
"converse"` puts every model on Converse.

AWS-defined discovery can show two models for one foundation model, for example `claude-haiku-4-5` and
`claude-haiku-4-5-global`. The **short id** is the preferred system profile: the geography prefix that matches your
first configured region (`us`, `eu`, `apac`, `jp`, `au`, `us-gov`), then `global`, then the other regions in the order
you configured them. The other profile gets a short geography suffix (`-global`, `-eu`, `-apac`, …); if two would
collide it adds the region, and the old `<slug>--<region>--<profile id>` form is kept as an alias. Both are separate AWS
inference profiles with their own routing and price, so both stay in `/model`.

## Commands

One command, with completions:

| Command                                               | Does                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `/bedrock` or `/bedrock status`                       | Profile, sign-in as last seen, models, route, spend and budget; no AWS call |
| `/bedrock doctor [offline\|call]`                     | Local checks, free AWS checks, or one tiny call                             |
| `/bedrock models`                                     | Short id, region, route and price; not-usable profiles after                |
| `/bedrock refresh`                                    | Re-read the profiles from AWS                                               |
| `/bedrock login`                                      | Renew the chosen AWS sign-in                                                |
| `/bedrock usage [day\|week\|month]`                   | Spend by model, tokens and cache share                                      |
| `/bedrock budget [amount\|off]`                       | Show, set or remove the display budget                                      |
| `/bedrock settings`                                   | Every setting, value and source                                             |
| `/bedrock set <key> <value>` / `/bedrock unset <key>` | Change `bedrock.json` safely                                                |
| `/bedrock migrate`                                    | Copy a 0.2.x `jig.json` section once                                        |
| `/bedrock help`                                       | The short table                                                             |

The old names `/bedrock-doctor`, `/bedrock-usage`, `/bedrock-stats`, `/bedrock-profiles`,
`/bedrock-refresh` and `/aws-login` still work for this release and name their replacement.

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
- [Spend command](docs/spend-command.md): the optional JSON contract and a ten-line example.
- [Not verified](docs/not-verified.md): read before you rely on it; what has run against real AWS, what the tests fake.

## Licence

MIT.

[ip-iam]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
