# jig-bedrock: Claude on AWS Bedrock for Pi

jig-bedrock adds Claude on AWS Bedrock to the Pi coding agent, for people who reach Claude through an AWS account. After a tool is loaded in the middle of a session, the next request read 34,216 tokens from the prompt cache and wrote 275; Pi's built-in Bedrock provider read 0 and wrote 34,463 (the session cost $0.0051 against $0.0099, with a prompt of about 34,000 tokens). This holds for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Opus 4.8, which use the Messages route; the other Claude models use the Converse route and behave like the built-in provider.

It also finds the models your account can use, renews an expired SSO sign-in, and shows the month's spend in Pi's footer.

![How a request runs: Pi sends a turn to jig-bedrock, which picks the Messages or the Converse route for the model and signs the request with your AWS profile. Around it: an expired sign-in is renewed, the models are kept for 24 hours, each reply's cost goes to a monthly record that feeds the footer, and Pi's built-in Bedrock provider keeps working.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/request-flow.svg)

_A request: jig-bedrock picks the route for the model, signs with your AWS profile, and records the cost of the reply._

## Set up in four steps

You need Node 22.19 or later, Pi 1.5 or later (1.5.0 is the oldest; CI runs the tests on it), the AWS CLI v2, and an AWS profile (a named sign-in in `~/.aws/config`) that can call Bedrock.

**1. Install the package.**

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

```text
Installing npm:@clawdbuilder/jig-bedrock...
Installed npm:@clawdbuilder/jig-bedrock
```

npm prints its own progress lines between those two lines; they are left out here.

Done when: `pi list` shows it:

```text
User packages:
  npm:@clawdbuilder/jig-bedrock
    ~/.pi/agent/npm/node_modules/@clawdbuilder/jig-bedrock
```

**2. Sign in.** Run `/login` and choose **Sign in with an API key**, then **Amazon Bedrock (jig-bedrock)**. That menu entry asks for no key: the next screens choose an AWS profile and what Bedrock should list.

```text
Select authentication method:
→ Sign in with an API key
Select provider to configure:
→ Amazon Bedrock (jig-bedrock)
How do you sign in to AWS?
→ An AWS profile that already works
  Create an IAM Identity Center (SSO) profile
  Create an IAM role profile
  Use the AWS credential chain (no profile)
  Use a Bedrock API key with Pi's own provider
Which AWS profile should Bedrock use?
→ my-profile
Which inference profiles should Bedrock list?
→ All AWS-defined Claude inference profiles
AWS regions for discovery (comma separated)
> us-east-1
```

then:

```text
Bedrock models loaded: 31. Choose one with /model.
```

Pi also prints "no default model is configured" in red after sign-in. That is Pi's wording for any provider an extension adds; step 3 is the fix. There is no supported extension hook to name a default model (Pi keeps `defaultModelPerProvider` for its own providers).

Done when: the last line is `Bedrock models loaded:` with a number above 0.

**3. Choose a model.** Run `/model` and type `sonnet-5-5` to filter:

```text
> sonnet-5-5
→ claude-sonnet-5-5-global [jig-bedrock]
  claude-sonnet-5-5 [jig-bedrock]
  claude-sonnet-5-global [jig-bedrock]
  claude-sonnet-5 [jig-bedrock]
  claude-sonnet-4-5 [jig-bedrock]
  claude-sonnet-4-5-global [jig-bedrock]
  Model Name: Claude Sonnet 5.5 · global
```

Move the arrow to the model you want with the arrow keys and press Enter. The `-global` id is an AWS global inference
profile: AWS may send the request to any region worldwide, while the plain id stays in the region's own geography; the
model and the package's price are the same.

Done when: Pi's footer shows the chosen id, for example `claude-sonnet-5-5`, with `Nov $0.00` under it.

**4. Check everything.**

```text
/bedrock doctor
```

```text
Bedrock doctor
✓ Node 26.13.0
✓ AWS CLI 2.34.46
✓ Settings: ~/.pi/agent/bedrock.json
✓ AWS profile: my-profile (from /login)
✓ Sign-in: AWS answered
✓ Models: 31 found in us-east-1 (AWS-defined)
✓ Selected model: claude-sonnet-5-5 · Messages route
– Spend command: not set
Bedrock is ready.
```

Done when: the last line is `Bedrock is ready.`

## Budget

```text
/bedrock budget 200
```

The footer then shows the month and the spend, for example `Nov $12.40 / $200`. It turns to Pi's warning colour at 80% and its error colour at 100%, and one notice appears at each. A `+` after the amount means some reply had no price.

The figure counts the replies of the `jig-bedrock` models in this machine's Pi sessions, at the prices in Pi's model list. It does not count other machines, other tools, or Pi's built-in provider. It is a figure to compare with, not an AWS limit, and it never blocks a request. To count something else, set a `spendCommand` ([Spend command](docs/spend-command.md)).

## Compared with Pi's built-in Bedrock provider

Both stay in `/model`; this package does not replace the built-in one.

|                              | Pi's built-in provider                                        | jig-bedrock                                                                                |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Install                      | None; it is part of Pi                                        | `pi install`                                                                               |
| Sign-in                      | A Bedrock API key, or the AWS credentials of your environment | An AWS profile (SSO, keys or a role)                                                       |
| Models                       | Pi's own list, with non-Claude models                         | Claude models found in your account, including application inference profiles found by tag |
| Expired SSO sign-in          | The request fails; you sign in again                          | Renewed, then the request is sent once more                                                |
| Cache after a tool is loaded | Rewritten                                                     | Kept, on the four models above                                                             |
| 1-hour cache                 | Yes, on Claude 4.5 and later                                  | Not on the Messages route; the Converse models keep it                                     |
| Month's spend and budget     | Not included                                                  | In the footer                                                                              |

![The same session on both routes. On Messages, call 2 after a tool load reads 34,216 tokens from the cache and writes 275, and the session costs $0.0051. On Converse, as in Pi's built-in provider, call 2 reads 0 and writes 34,463, and the session costs $0.0099.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/cache-after-tool-load.svg)

_One session, three calls, measured on AWS: a tool loaded in the middle rewrites the cache on Converse and not on Messages._

## Commands

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `/bedrock status`  | One screen: AWS profile, sign-in, models, route, spend. No AWS call. |
| `/bedrock doctor`  | Checks everything, then tells you the one next step.                 |
| `/bedrock models`  | Lists the models with their route and price.                         |
| `/bedrock refresh` | Reads the models from AWS again.                                     |
| `/bedrock login`   | Renews the AWS sign-in.                                              |
| `/bedrock usage`   | The spend by model, for a day, a week or a month.                    |

`/bedrock help` lists all of them, including `settings`, `set` and `budget`.

## When something is wrong

| You see                            | Run                |
| ---------------------------------- | ------------------ |
| Sign-in expired                    | `/bedrock login`   |
| Access denied                      | `/bedrock doctor`  |
| No models in `/model`              | `/bedrock refresh` |
| A model is missing after an update | `/bedrock models`  |
| The footer shows no amount         | `/bedrock usage`   |

What to expect, and the permissions AWS needs: [Troubleshooting](docs/troubleshooting.md).

## Limits

- Linux and WSL are tested. macOS runs the unit tests in CI but has not been tested against real AWS; reports and fixes are welcome. Native Windows is not supported.
- A Bedrock API key works through Pi's built-in provider, not this package.
- The spend figure counts this machine's Pi sessions, unless a `spendCommand` is set.
- The budget is a figure to compare with, not an AWS limit, and it never blocks a request.
- Opus 4.1 with thinking on fails on Converse, in Pi's built-in provider too.
- The Fable models need an account data-retention setting from AWS. They use Messages by the rule, but no real run could test them.
- Only SSO sign-ins are renewed. SSO and access keys were run against real AWS; an assumed role, `credential_process` and web identity were not ([sign-in methods](docs/settings.md#sign-in-methods)).
- On the Messages route the 1-hour cache is not used, so `PI_CACHE_RETENTION=long` has no effect there.
- The oldest supported Pi is 1.5.0; CI proves it.

## Update and uninstall

Update with `pi update npm:@clawdbuilder/jig-bedrock`, then `/reload`. Pi shows the changelog at the next start. Remove with `/logout` (choose this provider) and then `pi remove npm:@clawdbuilder/jig-bedrock`. Removal leaves these behind, and you can delete them:

| Left behind                               | What it is                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/bedrock.json`                | Your settings (in `PI_CODING_AGENT_DIR` if you set it).                                                                                 |
| `~/.cache/jig-bedrock/`                   | The catalog of models (in `XDG_CACHE_HOME` if you set it).                                                                              |
| `~/.local/state/jig-bedrock/`             | The spend record in `spend/`, `debug.log` if you turned it on, and `sso-runtime/` if it was needed (in `XDG_STATE_HOME` if you set it). |
| `~/.aws/config.jig-bedrock-backup-<time>` | Up to five backups of your AWS config, made before `/login` added an AWS profile. The AWS profiles it added stay in `~/.aws/config`.    |

Pi's own `auth.json` keeps the AWS profile's name until you run `/logout`. Sessions recorded with these models stay in Pi's session folder, and they need the package to resume.

## More detail

- Read [Settings](docs/settings.md) before you edit `bedrock.json` by hand.
- Read [How it works](docs/how-it-works.md) when you wonder why a model is on one route, or how models are found.
- Read [Troubleshooting](docs/troubleshooting.md) when a command ends with `✗` or a request fails.
- Read [Spend command](docs/spend-command.md) before you set a `spendCommand`.
- Read [Contributing](docs/contributing.md) before you change the package.
- Read [CHANGELOG.md](CHANGELOG.md) before you update.

## For an agent setting this up

- Do the four steps above in order. Each one has a "Done when" line: check it before the next.
- Step 2 opens a browser: ask the user to finish the sign-in. Never read or print credentials.
- The one check that proves success: `/bedrock doctor` ends with `Bedrock is ready`.

## Licence

MIT.
