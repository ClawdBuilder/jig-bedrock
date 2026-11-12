# jig-bedrock

Claude on AWS Bedrock for Pi, signed in with your AWS profile.

![Pi sends a request to jig-bedrock, which signs it for Amazon Bedrock. jig-bedrock finds your models, renews an expired SSO sign-in, keeps the prompt cache and shows spend in the footer.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/overview.svg)

_jig-bedrock sits between Pi and Amazon Bedrock and adds four things._

## Why use it

- After a tool loads: 275 tokens written to the cache, not 34,463.
- Lists your account's Claude models, by tag too.
- An expired SSO sign-in renews, and the request is sent once more.
- Month spend and budget in Pi's footer.

![Bar chart: after a tool loads, jig-bedrock writes 275 tokens to the cache and Pi built-in writes 34,463. Session cost is $0.0051 against $0.0099.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/cache-after-tool-load.svg)

_Claude Haiku 5.5, one prompt of about 34,000 tokens._

## Set up

![Four setup steps — install, sign in, pick a model, check — end at a green Ready check.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/setup.svg)

_Each step below ends with a "Done when" line._

You need: Node 22.19+, Pi 1.5 or later, AWS CLI v2, an AWS profile that can call Bedrock.

**1. Install**

```sh
pi install npm:@clawdbuilder/jig-bedrock
```

Done when `pi list` shows `npm:@clawdbuilder/jig-bedrock`.

**2. Sign in**

Run `/login`, choose **Sign in with an API key**, then **Amazon Bedrock (jig-bedrock)**; it asks for no key, and the next screens pick an AWS profile and the models.

```text
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

```text
Bedrock models loaded: 31. Choose one with /model.
```

Pi then says in red that no default model is configured; step 3 picks one.

Done when the last line is `Bedrock models loaded:` with a number above 0.

**3. Pick a model**

Run `/model`, type `sonnet-5-5`, choose with the arrow keys and Enter.

```text
> sonnet-5-5
→ claude-sonnet-5-5-global [jig-bedrock]
  claude-sonnet-5-5 [jig-bedrock]
  Model Name: Claude Sonnet 5.5 · global
```

A `-global` id lets AWS serve the request from any region; same model, same price ([Model ids](docs/how-it-works.md#model-ids)).

Done when the footer shows the chosen id and `Nov $0.00`.

**4. Check**

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

Done when the last line is `Bedrock is ready.`

## Budget

```text
/bedrock budget 200
```

`Nov $12.40 / $200`; warning at 80%, error at 100%. [Details](docs/how-it-works.md#spend-and-the-footer).

## Compared with Pi's built-in Bedrock provider

|                         | Pi built-in               | jig-bedrock                   |
| ----------------------- | ------------------------- | ----------------------------- |
| Install                 | Part of Pi                | `pi install`                  |
| Sign-in                 | API key or environment    | AWS profile: SSO, keys, role  |
| Models                  | Pi's list, non-Claude too | Claude models in your account |
| Expired SSO sign-in     | Request fails             | Renewed, sent once more       |
| Cache after a tool load | Rewritten                 | Kept on four models           |
| 1-hour cache            | Claude 4.5 and later      | Converse models only          |
| Spend and budget        | Not included              | In the footer                 |

## Commands

| Command            | What it does                     |
| ------------------ | -------------------------------- |
| `/bedrock status`  | Profile, sign-in, models, spend. |
| `/bedrock doctor`  | Checks; one next step.           |
| `/bedrock models`  | Models, route, price.            |
| `/bedrock refresh` | Reads models now, any cache age. |
| `/bedrock login`   | Renews the AWS sign-in.          |
| `/bedrock usage`   | Spend by model, period.          |

`/bedrock help` lists every command, including `settings`, `set` and `budget`.

## When something is wrong

| You see                            | Run                |
| ---------------------------------- | ------------------ |
| Sign-in expired                    | `/bedrock login`   |
| Access denied                      | `/bedrock doctor`  |
| No models in `/model`              | `/bedrock refresh` |
| A model is missing after an update | `/bedrock models`  |
| The footer shows no amount         | `/bedrock usage`   |

## Limits

- Linux/WSL tested. macOS: unit tests in CI, not run against real AWS. No native Windows.
- A Bedrock API key works through Pi's built-in provider, not this one.
- Spend counts this machine's Pi sessions, unless a `spendCommand` is set.
- The budget is a figure to compare with; it never blocks a request.
- Only SSO sign-ins are renewed.

## Update and uninstall

**Update:** `pi update npm:@clawdbuilder/jig-bedrock`, then `/reload`.

**Remove:** `/logout`, then `pi remove npm:@clawdbuilder/jig-bedrock`. It leaves some files: [Files on disk](docs/settings.md#files-on-disk).

## More detail

| Page                                       | Read it when         |
| ------------------------------------------ | -------------------- |
| [How it works](docs/how-it-works.md)       | Routes and ids.      |
| [Settings](docs/settings.md)               | Edit `bedrock.json`. |
| [Troubleshooting](docs/troubleshooting.md) | A command fails.     |
| [Spend command](docs/spend-command.md)     | When using one.      |

## For an agent setting this up

Do the four steps in order. Step 2 opens a browser: ask the user to finish. Never read or print credentials. Done when the doctor says `Bedrock is ready.`

## Licence

MIT.
