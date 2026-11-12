# Troubleshooting

Each section shows what you see, the command to run, and what to try next. `/bedrock doctor` is the general first step.

## Sign-in expired

**You see**

```text
✗ Sign-in: sign-in expired
Next: /bedrock login
```

**Run:** `/bedrock login`

**Still wrong?** Finish the browser sign-in. Only SSO sign-ins are repaired. For keys or a role, fix the AWS profile in the AWS CLI.

## Access denied

**You see**

```text
✗ Models: access denied while listing; ask your AWS administrator for bedrock:ListInferenceProfiles
Next: ask your AWS administrator for bedrock:ListInferenceProfiles, then /bedrock refresh
```

**Run:** `/bedrock doctor`

**Still wrong?** Give your AWS administrator the failed row and this table. Both routes need `bedrock:InvokeModelWithResponseStream` on the inference profile and each foundation model it routes to.

| Permission                              | Needed for                     | Resource                          |
| --------------------------------------- | ------------------------------ | --------------------------------- |
| `sts:GetCallerIdentity`                 | Account check and doctor       | `*`                               |
| `bedrock:ListInferenceProfiles`         | AWS-defined listing and doctor | `*`                               |
| `tag:GetResources`                      | Discovery by tag               | `*`                               |
| `bedrock:GetInferenceProfile`           | One profile, tag or hand mode  | The inference-profile ARN         |
| `bedrock:InvokeModelWithResponseStream` | Requests, both routes          | Profile and foundation-model ARNs |

## No models

**You see**

```text
✗ Models: no Claude models in eu-north-1
Next: /bedrock settings, then check regions
```

In tag mode the row says `no inference profiles with tag Team=payments`.

**Run:** `/bedrock refresh`

**Still wrong?** Run `/bedrock status`; choose an AWS profile with `/login` if none. Check `regions`, or the `tagKey`/`tagValue` pair. Then run `/bedrock models`.

## A model is missing after an update

**You see**

```text
– This Pi does not know the model: arn:aws:bedrock:us-east-1:…:inference-profile/orders-api, us-east-1
```

**Run:** `/bedrock refresh`

**Still wrong?** Update Pi; its model list may be older. Add the missing region to `regions`. A model with no price is still listed as “no price”.

## The footer shows no amount

**You see**

No spend line under Pi's footer.

**Run:** `/bedrock usage`

**Still wrong?** Select a jig-bedrock model with `/model`; the footer hides for other providers. Check the state folder is writable. A `+` means an unpriced reply.

## A 400 after a tool was loaded

**You see**

```text
400: tool_addition/tool_removal requires a model that supports mid-conversation system content
```

**Run:** `/bedrock set converseModels <short id>`

**Still wrong?** Run `/bedrock models` and use its short id. The route rule is [here](how-it-works.md#which-route-a-model-gets).

## The cache is written again after a tool load

**You see:** high cache-write tokens after a tool load.

**Run:** `/bedrock models`

**Still wrong?** That model is on Converse. Only Messages keeps the cache; force a model with `converseModels` or accept Converse.

## Settings are not valid

**You see**

```text
✗ Settings file is not valid JSON.
– File: ~/.pi/agent/bedrock.json
```

**Run:** `/bedrock settings`

**Still wrong?** Fix one key with `/bedrock set <key> <value>` or `/bedrock unset <key>`; see [Settings](settings.md).

## Your settings are in jig.json

**You see:** `Your Bedrock settings are in jig.json.`

**Run:** `/bedrock migrate`

**Still wrong?** Check the file was written next to it as `bedrock.json`, then `/reload`.

## A Fable model is refused

**You see:** an AWS error about data retention.

**Run:** `/bedrock doctor`

**Still wrong?** Ask your AWS administrator to change the account data-retention setting. Both routes are refused.

## A Bedrock API key does not work here

**You see:** requests use the wrong credentials.

**Run:** `/model`

**Still wrong?** This package signs with an AWS profile. A Bedrock API key belongs to Pi's built-in Bedrock provider.

[Back to the README](../README.md).

[ip-iam]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
