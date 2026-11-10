# Settings

Every setting of the `bedrock` section, the three discovery modes, and where each value comes from. The provider reads
the settings at Pi start and resolves the profile when the session starts, so `/login` takes effect without a reload.

## Where settings come from

With Jig, the provider reads the `bedrock` section of `jig.json` and merges it over `~/.pi/agent/bedrock.json`, then
applies the environment on top. A plain Pi install has no `jig.json`: the file and the environment are all.

`bedrock.json` holds the keys directly or inside a `bedrock` object. Three settings start programs: `ssoLoginCommand`,
`usageDir` and `browser`. Jig's `bedrock` section does not carry them; set them in `bedrock.json`
(`usageDir` in `JIG_BEDROCK_USAGE_DIR` also works).

## Every setting

| Setting            | Default                                         | Meaning                                                 |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `profile`          | unset                                           | The AWS profile for discovery, requests and sign-in     |
| `regions`          | `["us-east-1"]`                                 | Where to look for profiles                              |
| `team`             | none                                            | Tag mode: the value of the `Team` tag                   |
| `tagKey`           | `Team` in tag mode                              | Tag mode: the tag name to filter on                     |
| `tagValue`         | the value of `team`                             | Tag mode: the tag value to filter on                    |
| `activeTagKey`     | none                                            | Tag mode: an extra tag that must also match             |
| `activeTagValue`   | `true` when `team` is set                       | Tag mode: the extra tag's value                         |
| `profiles`         | none                                            | Explicit mode: inference-profile ARNs or ids            |
| `usageDir`         | `~/.local/share/usage-tool`                     | The folder holding the optional `usage` program         |
| `monthlyBudgetUsd` | none                                            | A figure for the footer; not an AWS limit               |
| `ssoLoginCommand`  | `["aws","sso","login","--profile","{profile}"]` | The argv that starts sign-in; `{profile}` is replaced   |
| `signInAtStart`    | `true`                                          | Refresh an expired SSO session when Pi starts           |
| `browser`          | unset                                           | The program that opens the sign-in address              |
| `api`              | `messages`                                      | `messages` (the Anthropic Messages route) or `converse` |

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

`signInAtStart: false` leaves sign-in to a failing request or `/aws-login`. The start-up check still runs read-only, and
an expired session shows “Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh.”

## The three discovery modes

The settings choose one mode; there is no fallback between them.

1. **System-defined (default).** With no `team`, tag setting or `profiles`, discovery lists the AWS-defined cross-region
   Claude profiles in `regions`. It includes `global.` profiles, whose cost and data residency differ.
2. **Tag filter.** `team` is a shorthand for `tagValue`, with `tagKey` defaulting to `Team`; setting `tagKey` or
   `tagValue` turns the mode on. `activeTagKey`/`activeTagValue` add a second tag that must match. When `team` is set and
   `activeTagKey` is not, `Active=true` is still required, so existing settings behave exactly as before.
3. **Explicit list.** `profiles` names ARNs or profile ids, and no tag or system search runs. An ARN in a region
   outside `regions` is reported, not read: add the region.

Only `ACTIVE` profiles are listed. The calls each mode makes are in [How it works](how-it-works.md#discovery).

## Environment

These variables override the same setting: `JIG_BEDROCK_TEAM`, `JIG_BEDROCK_TAG_KEY`, `JIG_BEDROCK_TAG_VALUE`,
`JIG_BEDROCK_PROFILE`, `JIG_BEDROCK_USAGE_DIR`, and `JIG_BEDROCK_REGIONS` (comma separated).

`PI_HOST_DIR` points at the Pi install when it is not beside `node`. `PI_CACHE_RETENTION` sets Pi's own cache retention;
the provider does not change it. `PI_CODING_AGENT_DIR` moves the agent folder, and with it `bedrock.json`.

## Credentials

Requests use the AWS SDK's default credential chain, loaded from Pi's install. Discovery runs the AWS CLI with
`--profile`, so the configured profile must be usable by the CLI as well as by the SDK.

| What you have                                | Requests       | Discovery                              | Sign-in repair                                       |
| -------------------------------------------- | -------------- | -------------------------------------- | ---------------------------------------------------- |
| SSO / IAM Identity Center                    | yes, SDK chain | yes, `--profile`                       | yes: checked at start, one retry before any response |
| Access keys in a profile                     | yes            | yes, `--profile`                       | no                                                   |
| Assume role in a profile                     | yes            | yes, `--profile`                       | no                                                   |
| `credential_process` in a profile            | yes            | yes, `--profile`                       | no                                                   |
| Web identity or instance role                | yes            | only through a profile the CLI can use | no                                                   |
| Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) | not supported  | no                                     | no                                                   |

What has run against real AWS, and what the other rows rest on: [Not verified](not-verified.md).

A Bedrock API key is refused. With `AWS_BEARER_TOKEN_BEDROCK` set, the provider does not choose an SSO profile, so no
repair is attempted, and a request that carries a key or bearer token fails with `Unapproved Bedrock authentication
scope`. There is no API-key fallback.

## The usage program

The footer and `/bedrock-usage` read an executable named `usage` in `usageDir`. The provider calls it with `--daily`,
`--weekly` or `--monthly` and `--output json`, and the program prints the spend as JSON. It receives `AWS_PROFILE` and
`BEDROCK_REGIONS` in its environment. The program is optional: without it, models, `/aws-login` and `/bedrock-refresh`
still work, and the footer and the usage commands have nothing to show.

If your usage CLI's own command is `usage-cli`, put this two-line wrapper at `~/.local/share/usage-tool/usage` and make
it executable:

```sh
#!/bin/sh
exec usage-cli usage "$@"
```

## Platforms

Linux and WSL2 are supported. macOS is expected to work but is not tested; reports and fixes are welcome.

Native Windows is not supported. The sign-in lock needs a POSIX owner and a private `0700` directory, and the
no-browser fallback is the WSL-only `bin/windows-browser` script: on WSL, an unset `browser` runs it, so the sign-in
address opens in the Windows browser.

[Back to the README](../README.md).
