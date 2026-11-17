# Troubleshooting

Each section shows what you see, the command to run, and what to try next. `/bedrock doctor` is the general first step.

## Sign-in expired

**You see**

```text
✗ Sign-in: sign-in expired
Next: /bedrock login
```

**Run:** `/bedrock login`

**Still wrong?** Finish the browser sign-in. An SSO sign-in and a role over SSO are repaired. Keys, or a role over keys, get the AWS CLI check instead: `aws sts get-caller-identity --profile <name>`, or fresh keys. `/bedrock login` never sends those in a circle.

## Access denied

**You see**

```text
✗ Models: Could not list inference profiles: AWS denied access.
Next: Ask your AWS administrator for bedrock:ListInferenceProfiles on the configured AWS profile; then /bedrock refresh.
```

**Run:** `/bedrock doctor`

**Still wrong?** Give your AWS administrator the failed row and this table. Both routes need `bedrock:InvokeModelWithResponseStream` on the inference profile and each foundation model it routes to.

| Permission                              | Needed for                                     | Resource                          |
| --------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `sts:GetCallerIdentity`                 | Account check and doctor                       | `*`                               |
| `bedrock:ListInferenceProfiles`         | AWS-defined listing and doctor                 | `*`                               |
| `tag:GetResources`                      | Discovery by tag                               | `*`                               |
| `bedrock:GetInferenceProfile`           | Reading an inference profile (by tag, by hand) | The inference-profile ARN         |
| `bedrock:InvokeModelWithResponseStream` | Requests, both routes                          | Profile and foundation-model ARNs |

[inference-profile permissions][ip-iam]

## No models

**You see**

```text
✗ Models: no Claude models in eu-north-1
Next: check regions and the tag or explicit list in /bedrock settings, then /bedrock refresh
```

In tag mode the row says `no inference profiles with tag Team=payments`.

**Run:** `/bedrock refresh`

**Still wrong?** Run `/bedrock status`; choose an AWS profile with `/login` if none. Check `regions`, or the `tagKey`/`tagValue` pair. If one region fails, the others still load and the row says `N models loaded from X of Y regions`; the failed region is tried again at the next start. Then run `/bedrock models`.

## AWS did not answer

**You see** (from `/bedrock refresh`)

```text
✗ Could not list inference profiles: AWS is limiting requests.
Next: AWS is limiting requests; wait a minute, then run /bedrock refresh.
```

**Run:** wait a minute, then `/bedrock refresh`.

**Still wrong?** The first line names the cause and the next line says what to do: an AWS problem on its side wants a later retry; expired credentials want the sign-in renewed; invalid credentials want the AWS profile's keys and region checked; unreachable AWS wants the network checked. `/bedrock doctor` names the same cause. In tag mode the first line says `tagged inference profiles`.

## AccessDenied for a model

**You see**

```text
AWS refused claude-opus-5 for your AWS role (no permission to call this inference profile). It is hidden from /model. /bedrock refresh tries it again. If your organisation marks the usable profiles with a second tag, run /login again or /bedrock settings.
```

**Run:** `/login` (choose the tag that marks the inference profiles your role may call) or `/bedrock settings`.

**Still wrong?** Ask your AWS administrator for `bedrock:InvokeModelWithResponseStream` on the application inference profile. `/bedrock models` lists refused models separately for seven days.

## Unknown preset

**You see**

```text
Bedrock: preset work is not defined; known: personal.
```

or, when the environment variable names it:

```text
Bedrock: JIG_BEDROCK_PRESET=work is not a known preset; showing the plain provider only. Known: personal.
```

**Run:** `/bedrock use`

**Still wrong?** Fix `preset` in `bedrock.json`, unset `JIG_BEDROCK_PRESET`, or add the preset with `/bedrock preset add <name>`. A bad `preset` in the file still registers every preset's provider; a bad `JIG_BEDROCK_PRESET` narrows `/model` to the plain provider only.

## A saved model's preset was removed

**You see**

```text
Bedrock: claude-haiku-5-5 is saved under jig-bedrock-work, whose preset no longer exists. Choose another with /model; Pi keeps the saved settings.
```

**Run:** `/model`, pick a model, then Ctrl+S to keep it; or `/bedrock preset add work` to recreate the preset.

**Still wrong?** The saved default still names the removed provider until you choose another, so the line is said once and then stays away. Pi's `settings.json` is not rewritten, and the unknown provider id does not block input.

## The saved model is only in a preset

**You see**

```text
Bedrock: preset work is saved, but the saved default model claude-haiku-5-5 is only in it. Run /bedrock use work, then Ctrl+S in /model.
```

**Run:** `/bedrock use work`, then Ctrl+S in `/model`.

**Still wrong?** This is the one 0.7.0 upgrade: `preset` no longer changes the plain provider's settings, so a saved default on `jig-bedrock` cannot find a model that only `work` lists. The line is said once; the two steps make the saved default name `jig-bedrock-work`.

## A model is missing after an update

**You see**

```text
– This Pi does not know the model: orders-api, us-east-1 · update Pi
```

**Run:** `/bedrock refresh`

**Still wrong?** Update Pi; its model list may be older. `/bedrock refresh` and `/bedrock status` count these models. Add the missing region to `regions`. A model with no price is still listed as “no price”.

## The footer shows no amount

**You see**

No spend line under Pi's footer.

**Run:** `/bedrock usage`

**Still wrong?** Select a jig-bedrock model with `/model`; the footer hides for other providers. Check the state folder is writable. A `+` means an unpriced reply. After `preset add` on a preset with no cached models, the footer stays on the model in use; it switches when you select one of the new preset's models.

## A 400 after a tool was loaded

**You see**

```text
400: tool_addition/tool_removal requires a model that supports mid-conversation system content
```

**Run:** add the id to the list: `/bedrock set converseModels <ids already there>,<short id>`. The value replaces the whole list, so keep the ids already in it.

**Still wrong?** Run `/bedrock models` and use its short id. The route rule is [here](how-it-works.md#which-route-a-model-gets).

## The cache is written again after a tool load

**You see:** high cache-write tokens after a tool load.

**Run:** `/bedrock models`

**Still wrong?** Expected on Converse; Pi's built-in provider does the same. Only the four Messages models keep the cache; the route column shows each model's route. Nothing to set.

## Settings are not valid

**You see**

```text
✗ Settings file is not valid JSON.
– File: ~/.pi/agent/bedrock.json
```

**Run:** `/bedrock settings` shows the file path.

**Still wrong?** Fix the JSON by hand, or move the file aside and run `/login` again. `/bedrock set` and `/bedrock unset` refuse a file that is not valid JSON; see [Settings](settings.md).

## Your settings are in jig.json

**You see:** `Your Bedrock settings are in jig.json.`

**Run:** `/bedrock migrate`

**Still wrong?** Check the file was written next to it as `bedrock.json`, then `/reload`.

## A Fable model is refused

**You see:** an AWS error about data retention.

**Run:** `/bedrock doctor`

**Still wrong?** Ask your AWS administrator to change the account data-retention setting. Both routes are refused.

## A Bedrock API key does not work here

**You have:** a Bedrock API key and no AWS profile.

**Run:** `/model`, then pick an `amazon-bedrock` model.

**Still wrong?** Pi's built-in provider takes the key; this package signs with an AWS profile.

[Back to the README](../README.md).

[ip-iam]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
