# How it works

This page holds the words the other pages use, the rule that picks a route for each model, how models are found, and
what runs when. Read it when a model is missing, a request fails, or a model shows an unexpected route.

## The words

Every page uses these five words and no others for these things. The word "profile" is never used alone, because AWS
uses it for two different things.

| Word                              | Meaning                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS profile**                   | A named sign-in in your AWS CLI configuration (`~/.aws/config`), such as `my-profile`. It is who you are to AWS. The `profile` setting, `/login` and `AWS_PROFILE` all name one.                                                                     |
| **Inference profile**             | What AWS calls one entry in its list of models you can call. Each one has an ARN (an AWS address) and points at one foundation model, such as Claude Sonnet 5.5.                                                                                     |
| **AWS-defined inference profile** | An inference profile AWS makes for everyone. It routes a request to the best region of a group, so its id starts with a geography such as `us.` or `global.`. This is the default way models are found.                                              |
| **Application inference profile** | An inference profile your team makes in your own account. It can carry tags, which is how a team finds its own models.                                                                                                                               |
| **Model**                         | What you pick in `/model`. One inference profile becomes one model, named by a short id such as `claude-sonnet-5-5`.                                                                                                                                 |
| **Route**                         | How a request travels to Bedrock. There are two. **Messages** is the Anthropic Messages interface of Bedrock, which this package signs itself. **Converse** is Bedrock's general interface, which Pi's own Bedrock code uses.                        |
| **Catalog**                       | The saved list of inference profiles found in your account: `~/.cache/jig-bedrock/catalog.json` (in `XDG_CACHE_HOME` if you set it). Your cache folder may be a link to another disk; the `jig-bedrock` folder and the file in it must not be links. |

## Which route a model gets

Messages is better for one reason: when a tool is loaded in the middle of a session, the request after it still reads
the prompt from the cache. On Converse the same step rewrites the whole prompt at the cache-write price.
[The measured numbers](../README.md#compared-with-pis-built-in-bedrock-provider) are in the README.

Bedrock does not accept that on every Claude model. Pi's own list of Anthropic models records which ones do, in a flag
named `supportsMidConvoToolChanges`.
The route rule follows that flag. It asks these questions in order, and the first answer wins:

1. Is it a Claude model? If not, Converse.
2. Is `api` set to `converse`, or is the model in `converseModels`? Then Converse.
3. Is the model in `messagesModels`? Then Messages.
4. Is it a known exception (today: Opus 5)? Then Converse.
5. Does the installed Pi list the model, and does its entry say tool changes work? Then Messages. Otherwise Converse.

A Claude model newer than the installed Pi uses Converse too, until you update Pi or
add it to `messagesModels`. The reason for each model is one of these short phrases, and `/bedrock models` shows it:
"Pi lists tool changes", "not on the Messages route", "your setting", "known exception", "this Pi does not know the
model".

The table is what real runs on AWS showed on 2026-11-10 (a session that loads seven tools in the middle, with thinking
on and off, a prompt of about 14,000 tokens):

| Model                                     | Route                            | What the run showed on the Messages route                                                                                                                                            |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Haiku 5.5, Sonnet 5.5, Opus 5.5, Opus 4.8 | Messages                         | Works. The request after the tool load read 14,011 to 14,015 tokens from the cache.                                                                                                  |
| Fable models                              | Messages (Pi lists tool changes) | Not tested. AWS refused them on both routes until an account data-retention setting is changed.                                                                                      |
| Opus 5                                    | Converse (known exception)       | Pi lists tool changes, but with thinking high the request failed with a 400 (`output_config` not permitted). With thinking off, a content filter blocked the request after the load. |
| Sonnet 5                                  | Converse                         | A 400 as soon as a tool is loaded.                                                                                                                                                   |
| Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5 | Converse                         | A 400 as soon as a tool is loaded.                                                                                                                                                   |
| Opus 4.5, Sonnet 4.5, Opus 4.1            | Converse                         | A 404 at once: AWS does not offer these on the Messages route.                                                                                                                       |

On Converse the same sessions finished for Opus 5 and Sonnet 4.5. Opus 4.1 with thinking on fails on Converse: AWS
rejects the request, and Pi's built-in Bedrock provider fails the same way.

Both routes stream the reply. The footer and the spend record are the same on both. On Messages, the model declares
only the 5-minute cache lifetime: the package does not send the 1-hour cache setting on that route, so
`PI_CACHE_RETENTION=long` has no effect there. Converse models keep both lifetimes.

## How models are found

![The three ways models are found: AWS-defined, by tag, or listed by hand. All run the AWS CLI with your AWS profile and only read. The result is the catalog, a file kept for 24 hours, which fills Pi's model list.](https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/docs/img/discovery.svg)

_Discovery runs the AWS CLI with your AWS profile, reads three kinds of lists, and saves the result as the catalog._

The settings choose one way; there is no fallback between them. Every way starts with `aws sts get-caller-identity`,
which gives the account id. Then, by way:

- **AWS-defined (default).** `aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED` for each region in
  `regions` (more calls if a region has more than one page). The listing already carries each name, status and model, so
  there is no read per inference profile. Only entries that mention Claude are kept.
- **By tag.** `aws resourcegroupstaggingapi get-resources --resource-type-filters bedrock:application-inference-profile`
  for each region, filtered by `tagKey` and `tagValue` (and the optional second tag), then
  `aws bedrock get-inference-profile` for each match, up to four at a time.
- **Listed by hand.** `aws bedrock get-inference-profile` for each entry of `profiles`, with no tag call and no listing.
  An ARN in a region outside `regions` is reported, not read.

Only inference profiles with the status `ACTIVE` are kept. The foundation model is read from the model address inside
the inference profile. An inference profile that points at another one is followed, up to two levels. `GetFoundationModel`
is never called. The package keeps at most 256 inference profiles. One AWS call may take 20 seconds, and the whole run 90 seconds.

The catalog is written with private permissions and an atomic rename. It records the AWS profile, the regions and the
discovery settings, so a changed setting discards it. A changed account is noticed at the next discovery and the file is
removed. Until a refresh finishes, the saved models stay in `/model`.

An inference profile is not listed as a model when Pi has no metadata for its foundation model (update Pi) or the model
has no price in Pi's registry. A model with no price is still listed and marked "no price"; its replies count as
unpriced in the spend figure. `/bedrock models` names up to three rejected inference profiles with the reason, then a count.

## Model ids

A model is named by a short id: the Claude name and version, such as `claude-sonnet-5-5`, from Pi's registry. One
foundation model can have more than one inference profile (an AWS-defined `us.` one and a `global.` one, for example).
The first AWS-defined inference profile by geography keeps the plain short id: the geography of your first region, then
`global`, then the others in the order of `regions`. Another inference profile for the same model gets a longer id that
says what differs, and `/bedrock models` lists every id. Two application inference profiles for one model are both
given the longer form.

Pi records a reply as `jig-bedrock/<short id>`. The inference-profile ARN goes on the wire only, so session lists show
no account id.

## Sign-in repair

Requests use the AWS SDK's credential chain for the AWS profile. Discovery runs the AWS CLI with `--profile`, so the AWS
profile must work in both. Only IAM Identity Center (SSO) sign-ins are repaired:

1. **At session start** the package checks the SSO sign-in without calling AWS (it reads the saved token's expiry). If it
   has expired, you get a notice to run `/bedrock login`. With `signInAtStart: true` it starts the sign-in at once; the
   default is `false`, so a browser never opens just because Pi started.
2. **At a request.** If a request fails on this machine before any reply because the SSO session has expired, the
   package says "Restoring AWS SSO", runs the `ssoLoginCommand` (`aws sso login --profile <name>` by default), and sends
   the same request once more. It never sends it a third time, and it never repeats an agent turn.
3. **At `/bedrock login`** the same sign-in runs when you ask. One login runs at a time, however many requests wait for
   it; a lock file in your runtime folder keeps two Pi processes apart.

A browser opens for the sign-in. On WSL, with no `BROWSER` set, the package opens the Windows browser through
`bin/windows-browser`; `browser` in `bedrock.json` names another program and wins everywhere. The package never reads or
stores a password or token: the AWS CLI owns the sign-in, and `/login` stores only the AWS profile's name.

Only SSO is repaired. Which other sign-in methods work, and which were run against real AWS, is in
[Settings](settings.md#sign-in-methods).

## What runs when

| When                                 | What happens                                                                                                                                                                                                            | Calls AWS?       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Pi starts the package                | Settings are read and the commands and the provider are registered.                                                                                                                                                     | No               |
| A session starts                     | The AWS profile is chosen; the sign-in is checked; the catalog is read from the cache and refreshed in the background if it is older than 24 hours; the footer is set; earlier replies of this month are imported once. | Only the refresh |
| A request                            | The route comes from the model; credentials are built on the first Messages request; an expired sign-in is repaired and the request sent once more.                                                                     | Yes, the request |
| A reply ends                         | One line is added to the spend record, the footer is updated, a budget notice may appear.                                                                                                                               | No               |
| You open `/model`                    | The saved catalog is shown at once; if it is older than 24 hours it is read again in the background, and Pi says so if that fails.                                                                                      | Only the refresh |
| `/bedrock refresh`, `/bedrock login` | Discovery runs now, whatever the cache age, or the sign-in runs.                                                                                                                                                        | Yes              |
| `/bedrock doctor`                    | Local checks, then three free AWS calls. `doctor offline` makes none.                                                                                                                                                   | Yes, free        |

Nothing waits for AWS at start: a slow AWS never blocks Pi.

## Spend and the footer

After every reply from this provider, one line is added to this month's record under
`${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/spend/`. The record has the time, session id, short model id, region,
route, four token counts, the cost Pi computed and a priced flag. It has no prompt, ARN, account id or AWS profile name.
The first time in a month with no record, replies from this agent folder's earlier sessions are imported once (at most
2,000 files and 10 seconds), and the import is marked so it never runs twice.

The footer shows the month and this machine's total, for example `Nov $12.40`, or `Nov $12.40 / $200` with a budget. A
`+` after the amount means some reply had no price. It turns to Pi's warning colour from 80% of the budget and its error
colour from 100%. It is cleared when a model of another provider is selected.

The budget is a figure to compare with, not an AWS limit. One notice appears when the month passes 80%, one when it
passes 100%, and one at session start while over 100%; a small state file in the spend folder keeps the first two to
once a month per machine. No request is ever blocked. With a `spendCommand`, the footer and budget use its figure
instead: see [Spend command](spend-command.md).

[Back to the README](../README.md).
