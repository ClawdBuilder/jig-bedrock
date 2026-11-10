# Troubleshooting

Find your symptom, run the command, and compare with what to expect. Every command here is a `/bedrock` command typed
in Pi. Each one prints a title and rows. A row starts with a mark: `✓` fine, `✗` a problem, `!` needs attention, `–` not
known yet. (With `NO_COLOR` set, or a terminal that is not UTF-8, the marks are the words ok, failure, warning and
skipped.) The last line, `Next:`, is the one command to run now.

If you do not know the symptom, start with `/bedrock doctor`. It ends with `Bedrock is ready` or with a count of
problems and one `Next:` line.

## Sign-in expired

You see "Sign-in expired", or a request stops with a message about your AWS SSO session.

1. Run `/bedrock login`. A browser opens; finish the sign-in there.
2. Run `/bedrock refresh` if the model list was empty.

Expect `/bedrock doctor` to show the sign-in row with `✓`. Pi renews an expired SSO sign-in by itself when a request
fails, and sends the request once more, so you meet this only when the renewal could not finish (no browser, a closed
window, a timeout of five minutes). Only SSO sign-ins are renewed. For access keys or an assumed role, fix the AWS
profile in the AWS CLI.

## Access denied

A row or a failed request says access is denied.

Run `/bedrock doctor`. It makes three free AWS calls and says which one was refused: who you are, listing inference
profiles, or reading one. Give your AWS administrator the row and the permission that fits, from this table.

| Permission                              | Needed for                                                     | Resource                                                             |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sts:GetCallerIdentity`                 | The account check before discovery, and the doctor             | `*`                                                                  |
| `bedrock:ListInferenceProfiles`         | AWS-defined discovery: the list; the doctor                    | `*`                                                                  |
| `tag:GetResources`                      | Discovery by tag                                               | `*`                                                                  |
| `bedrock:GetInferenceProfile`           | Discovery by tag or by hand: one inference profile; the doctor | The inference-profile ARN                                            |
| `bedrock:InvokeModelWithResponseStream` | Requests, on both routes                                       | The inference-profile ARN and each foundation-model ARN it routes to |

Every request streams. Messages goes to Bedrock's Anthropic interface and Converse uses `ConverseStream`; both are
authorized by `bedrock:InvokeModelWithResponseStream`, so `bedrock:InvokeModel` is not needed. No `ListFoundationModels`
or `GetFoundationModel` permission is needed: the package reads the foundation model from the inference profile's ARN.

An inference profile must allow itself **and** the foundation model in every region it routes to. AWS's
[inference-profile permissions][ip-iam] say the same. A role that only allows application inference profiles is refused
for the AWS-defined ones: use discovery by tag or by hand (`/bedrock settings` shows which way you use).

## No models

`/model` shows no jig-bedrock models.

1. Run `/bedrock status`. If it says no AWS profile is chosen, run `/login` and choose Amazon Bedrock (jig-bedrock).
2. Run `/bedrock refresh`, then `/bedrock models`.

Expect `/bedrock models` to list models, each with its short id, region, route and price. If the list is empty, the
refresh row says why in plain words: the sign-in expired (see above), access was denied (see above), or no inference
profiles were found. For "no inference profiles found", check the way models are found: `/bedrock settings` shows
`tagKey`, `tagValue`, `profiles` and `regions`. A tag that does not match anything, or a region where AWS offers no
Claude inference profiles, gives an empty list.

A refresh that times out (the whole run is limited to 90 seconds) is slower than usual because the AWS CLI is slow: an
assumed-role AWS profile assumes the role again on each call. List fewer regions in `regions`.

## A model is missing after an update

A model you used yesterday is gone from `/model`, or a new Claude model never appears.

Run `/bedrock models`. After the models it lists the rejected inference profiles, up to three, then a count, each with a
reason. The usual reason is that Pi has no metadata for the model, because Pi's own model list is older than the model. Update Pi, then run `/bedrock refresh`. A model with no price is still listed, marked "no price".

A model that is missing because it is in your account but not in your `regions` needs the region added to `regions`.

## The footer shows no amount

You expect a line such as `Nov $12.40` at the bottom and see nothing.

The footer shows only while a jig-bedrock model is selected: it is cleared when you pick a model of another provider, and
it does not exist in print or JSON mode. Select a model with `/model`, then run `/bedrock usage`.

Expect `/bedrock usage` to show this machine's Pi sessions as a dollar amount. If it shows `0.00` after replies, the
record could not be written: Pi says so once per session, and the state folder (`~/.local/state/jig-bedrock/spend/`,
or `XDG_STATE_HOME`) must be writable. A `+` after the amount means some reply had no price; that is normal for a model
with no price. If you set a `spendCommand`, `/bedrock doctor` says why the command failed, and the footer uses this
machine's figure meanwhile.

## A 400 after a tool was loaded

A request fails with a 400 from AWS right after the model loaded a tool in the middle of a session.

That model is on the Messages route, and AWS does not accept mid-session tool changes for it. The package puts a model
on Messages only when the installed Pi lists tool changes for it, or when you forced it with `messagesModels`. Run
`/bedrock models` to see the model's route and the reason. Then keep it on Converse:

```
/bedrock set converseModels <short id>
```

Use the short id that `/bedrock models` shows, such as `claude-opus-5`; add more ids after commas. The models the
package puts on Messages by itself were run on real AWS: see
[which route a model gets](how-it-works.md#which-route-a-model-gets).

## The prompt is written to the cache again after a tool load

A model on Converse writes the whole prompt to the cache again when a tool is loaded in the middle of a session. That is
expected: it is how Converse and Pi's built-in provider behave. Only the models on the Messages route keep the cache;
the README lists them.

## Settings are not valid

At the start of a session Pi says the Bedrock provider is disabled, or names a key in `bedrock.json` it ignores.

Run `/bedrock settings`. It names the key and the file. Fix the value with `/bedrock set <key> <value>`, or `/bedrock
unset <key>`, or edit the file; see [Settings](settings.md). A file that is not valid JSON is reported by name too.

## Your settings are in jig.json

At the start of a session you see "Your Bedrock settings are in jig.json". That is a 0.2.x file. Run `/bedrock
migrate`: it copies the section to `bedrock.json`, once, and leaves `jig.json` alone.

## A Fable model is refused

A Fable model returns an error about a data-retention mode. That is an account setting at AWS, on both routes. Ask your
AWS administrator to change it; the package cannot.

## A Bedrock API key does not work here

This package signs in with an AWS profile. A Bedrock API key works through Pi's built-in Amazon Bedrock provider, which
is installed with Pi and stays beside this one in `/model`.

[Back to the README](../README.md).

[ip-iam]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
