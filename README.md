# jig-bedrock: Claude on AWS Bedrock for Pi

A Pi provider for Claude on AWS Bedrock. It finds the application inference profiles your account can use, keeps the
Anthropic Messages route (where the prompt cache survives tool changes), and falls back to Converse per model.

## The gap it fills

Pi's built-in Bedrock provider uses Converse only, has a fixed model list and no profile discovery, SSO repair or budget
footer. This package adds the Messages route with SigV4, discovery by an AWS tag, repair through `aws sso login`, and an
optional spend line. It works in plain Pi; when [Jig](https://github.com/ClawdBuilder/jig) is installed it also uses Jig's
records and footer, but Jig is not required.

## Install

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Requirements: Node 22.19 or later, Pi 1.5 or later, AWS CLI v2, and an AWS profile whose SSO session the CLI can refresh.
Linux, WSL2 and macOS are supported; Windows is not.

## Minimum settings

Add a `bedrock` section to `jig.json` (or the same keys through the environment):

```json
{ "bedrock": { "team": "my-team" } }
```

`team` is the value of the AWS tag on your inference profiles. The package discovers active profiles with that value.

| Setting                           | Default                                         | Meaning                                                                                            |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `team`                            | required                                        | The exact AWS tag value on your application inference profiles                                     |
| `tagKey`                          | `Team`                                          | The AWS tag that names your team on the inference profiles                                         |
| `tagValue`                        | the value of `team`                             | The tag value to discover; `team` is kept for compatibility                                        |
| `activeTagKey` / `activeTagValue` | `Active` / `true`                               | The tag that marks a profile as usable                                                             |
| `profile`                         | `my-bedrock-profile`                            | The AWS profile for discovery, requests and sign-in                                                |
| `regions`                         | `["us-east-1"]`                                 | Where to look for profiles                                                                         |
| `usageDir`                        | `~/.local/share/usage-tool`                     | Optional directory holding an executable `usage` that prints the usage JSON; omit if you have none |
| `monthlyBudgetUsd`                | none                                            | A figure for the footer, not an AWS limit                                                          |
| `ssoLoginCommand`                 | `["aws","sso","login","--profile","{profile}"]` | The owning tool starts the sign-in; this package never handles a password or token                 |
| `signInAtStart`                   | `true`                                          | Refresh an expired SSO session when Pi starts                                                      |
| `browser`                         | WSL's Windows browser                           | Program that opens the sign-in address                                                             |
| `api`                             | `messages`                                      | `messages` (cache-friendly) or `converse`                                                          |

Plain Pi reads the same keys from `~/.pi/agent/bedrock.json` (or a `bedrock` object in it). With Jig, that file is read
first and Jig's `bedrock` section is merged on top; Jig must load before the provider, as in Jig's normal order. A project's `jig.json` may set
the catalog keys, but `ssoLoginCommand`, `usageDir` and `browser` are ignored there: programs run only from the user's file or the
environment.

Environment: `JIG_BEDROCK_TEAM`, `JIG_BEDROCK_PROFILE`, `JIG_BEDROCK_REGIONS`, `JIG_BEDROCK_USAGE_DIR`,
`JIG_BEDROCK_TAG_KEY`, `JIG_BEDROCK_TAG_VALUE`. `PI_HOST_DIR` points at the Pi install when it is not beside `node`.
`PI_CACHE_RETENTION` sets Pi's own cache retention; the provider does not change it.

## Commands

| Command                   | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `/bedrock-refresh`        | Refresh the discovered profiles                                                    |
| `/bedrock-usage [period]` | Show the usage program's daily, weekly or monthly figures                          |
| `/bedrock-stats`          | Show the same cached figures as a short line                                       |
| `/bedrock-profiles`       | List the discovered profiles and why any are unavailable                           |
| `/aws-login`              | Start the owning AWS CLI's `sso login` for the configured profile                  |
| `/bedrock-doctor`         | Probe Node, AWS CLI, bash, jq and the optional usage program; it does not call AWS |

The footer shows the month's spend when a usage program and budget are configured. That program is an executable named
`usage` in `usageDir`; it is called as `usage --daily|--weekly|--monthly --output json` with `AWS_PROFILE` set, and it must
print one JSON object:

```json
{
    "schema_version": 1,
    "command": "usage",
    "user": "me",
    "period": "Current Month",
    "summary": {
        "total_requests": 2,
        "total_input_tokens_fresh": 100,
        "total_cache_read_tokens": 20,
        "total_cache_write_tokens": 10,
        "total_input_tokens": 130,
        "total_output_tokens": 40,
        "total_estimated_cost_usd": 0.42
    },
    "profiles": [
        {
            "model_slug": "claude-sonnet-5-5",
            "profile_name": "my-profile",
            "requests": 2,
            "input_tokens_fresh": 100,
            "cache_read_tokens": 20,
            "cache_write_tokens": 10,
            "total_input_tokens": 130,
            "output_tokens": 40,
            "estimated_cost_usd": 0.42
        }
    ]
}
```

The 2.x shape may omit `schema_version`/`command` and each row's `user`; extra keys are ignored. A missing or unpriced row
leaves the spend unknown, not zero.

## Cache

On the Messages route, the tools array stays stable and the prompt cache survives a tool change. On Converse, a changed
tool list rewrites the cache; choose `api: "converse"` only for a model that needs it.

## Tests

```sh
npm test
npm run check
npm run scan
```

WSL uses `bin/windows-browser` when `browser` is unset, so the sign-in opens on Windows.

The real-AWS tests are manual: they cost money and need the user's approval. Unit tests use recorded AWS shapes and a fake
CLI.

## Licence

MIT.
