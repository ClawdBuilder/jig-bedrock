# Settings

Every setting of the `bedrock` section, the three discovery modes, and where each value comes from. The provider reads
the settings at Pi start and resolves the profile when the session starts, so `/login` takes effect without a reload.

## Where settings come from

The provider reads `~/.pi/agent/bedrock.json` and then applies the environment on top. A file may hold the keys at the
top level or inside a `bedrock` object.

`bedrock.json` holds the keys directly or inside a `bedrock` object. Three settings start programs: `ssoLoginCommand`,
`browser`; set them in `bedrock.json`.

## Every setting

| Setting            | Default                                         | Meaning                                                 |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `profile`          | unset                                           | The AWS profile for discovery, requests and sign-in     |
| `regions`          | `["us-east-1"]`                                 | Where to look for profiles                              |
| `tagKey`           | none                                            | Tag mode: the tag name to filter on                     |
| `tagValue`         | none                                            | Tag mode: the tag value to filter on                    |
| `activeTagKey`     | none                                            | Tag mode: an extra tag that must also match             |
| `activeTagValue`   | none                                            | Tag mode: the optional second tag's value               |
| `profiles`         | none                                            | Explicit mode: inference-profile ARNs or ids            |
| `spendCommand`     | none                                            | Optional argv that prints this month's spend            |
| `monthlyBudgetUsd` | none                                            | A figure for the footer; not an AWS limit               |
| `ssoLoginCommand`  | `["aws","sso","login","--profile","{profile}"]` | The argv that starts sign-in; `{profile}` is replaced   |
| `signInAtStart`    | `false`                                         | Refresh an expired SSO session when Pi starts           |
| `browser`          | unset                                           | The program that opens the sign-in address              |
| `api`              | `messages`                                      | `messages` (the Anthropic Messages route) or `converse` |
| `converseModels`   | none                                            | Short model ids (`claude-opus-5`) that stay on Converse |
| `messagesModels`   | none                                            | Short model ids to put on Messages, for a newer model   |

The package never handles a password or token: `ssoLoginCommand` starts the owning tool's login, and `/login` stores
only the profile name (in Pi's `auth.json`, as `env.AWS_PROFILE`).

### Where the profile comes from

When `profile` is unset, the provider takes the first of these that exists:

1. the `profile` setting (or `JIG_BEDROCK_PROFILE`, which overrides it);
2. the profile chosen at `/login` (Sign in with an API key → Amazon Bedrock (jig-bedrock)), kept in Pi's credential
   for this provider;
3. `AWS_PROFILE`;
4. `AWS_DEFAULT_PROFILE`;
5. the `default` profile, when `aws configure list-profiles` names it;
6. with none of those, the AWS credential chain (environment, container or instance role).

A configured profile that `aws configure list-profiles` does not name resolves to no models: the start-up notice and
`/bedrock-doctor` say which profile is missing and point to `/login`.

`signInAtStart: true` refreshes an expired session when Pi starts; the default leaves sign-in to a failing request or `/aws-login`. The start-up check still runs read-only, and
an expired session shows “Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh.”

## The three discovery modes

The settings choose one mode; there is no fallback between them.

1. **System-defined (default).** With no tag setting or `profiles`, discovery lists the AWS-defined cross-region
   Claude profiles in `regions`. It includes `global.` profiles, whose cost and data residency differ.
2. **Tag filter.** `tagKey` and `tagValue` turn the mode on. `activeTagKey`/`activeTagValue` add a second tag that must
   match. A 0.2.x `team` value is still read once as `tagKey: "Team"`, `tagValue: <team>`, `activeTagKey: "Active"`,
   `activeTagValue: "true"`; `/bedrock migrate` writes the generic keys. When the old `team` is set and
   `activeTagKey` is not, `Active=true` is still required, so existing settings behave exactly as before.
3. **Explicit list.** `profiles` names ARNs or profile ids, and no tag or system search runs. An ARN in a region
   outside `regions` is reported, not read: add the region.

Only `ACTIVE` profiles are listed. The calls each mode makes are in [How it works](how-it-works.md#discovery).

## Environment

These variables override the same setting: `JIG_BEDROCK_TEAM`, `JIG_BEDROCK_TAG_KEY`, `JIG_BEDROCK_TAG_VALUE`,
`JIG_BEDROCK_PROFILE` and `JIG_BEDROCK_REGIONS` (comma separated).

`PI_CACHE_RETENTION` sets Pi's own cache retention;
the provider does not change it. `PI_CODING_AGENT_DIR` moves the agent folder, and with it `bedrock.json`.

## Credentials

Requests use the AWS SDK's default credential chain, loaded from Pi's install. Discovery runs the AWS CLI with
`--profile`, so the configured profile must be usable by the CLI as well as by the SDK.

| What you have                                | Requests               | Discovery                              | Sign-in repair                                       |
| -------------------------------------------- | ---------------------- | -------------------------------------- | ---------------------------------------------------- |
| SSO / IAM Identity Center                    | yes, SDK chain         | yes, `--profile`                       | yes: checked at start, one retry before any response |
| Access keys in a profile                     | yes                    | yes, `--profile`                       | no                                                   |
| Assume role in a profile                     | yes                    | yes, `--profile`                       | no                                                   |
| `credential_process` in a profile            | yes                    | yes, `--profile`                       | no                                                   |
| Web identity or instance role                | yes                    | only through a profile the CLI can use | no                                                   |
| Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) | Pi's built-in provider | no                                     | no                                                   |

What has run against real AWS, and what the other rows rest on: [Not verified](not-verified.md).

A Bedrock API key belongs to Pi's built-in Amazon Bedrock provider. This package's models use the AWS profile; an
ambient `AWS_BEARER_TOKEN_BEDROCK` is cleared for their requests and does not replace the profile. `/login` says where
to go for a key and does not ask for one.

## Spend and budget

After every reply this package appends one line to `${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/spend/YYYY-MM.jsonl`:
the time, session, short model id, region, route, the four token counts, the cost Pi computed and whether the model had a
price. The folder is private to the user. Nothing from a prompt, an ARN, an account id or a profile is written.

The footer shows `Nov $12.40` (or `Nov $12.40 / $200` with a budget); a trailing `+` means some reply had no price. It
is display only: it is not AWS spend and it never blocks a request.

`monthlyBudgetUsd` sets the display budget. One notice appears when the month passes 80%, one when it passes 100%, and
one at session start while over 100%. The state file remembers the first two for the month, across Pi processes.

`spendCommand` is optional: an argv array, run without a shell at most once every 10 minutes and at `/bedrock usage`, with
the settings' AWS profile and first region in its environment. It prints one JSON object:
`{ "month": "2026-11", "spentUsd": 203.4 }`. When it works, the footer and budget use its figure; when it fails, they fall
back to this machine's record and `/bedrock doctor` says why. The contract and a ten-line example:
[Spend command](spend-command.md).

## Platforms

Linux and WSL2 are supported. macOS is expected to work but is not tested; reports and fixes are welcome.

Native Windows is not supported. The sign-in lock needs a POSIX owner and a private `0700` directory, and the
no-browser fallback is the WSL-only `bin/windows-browser` script: on WSL, an unset `browser` runs it, so the sign-in
address opens in the Windows browser.

[Back to the README](../README.md).
