# How it works

What happens between a setting and a streamed reply: discovery, the two routes to Claude, model ids, and the spend
record and footer. Read it when a profile is missing, a request fails, or a model shows an unexpected name.

## When things run

Settings are read when the extension loads. The catalog is read from its cache at that point, and the session start
refreshes it in the background unless the cache is younger than 24 hours, so Pi never waits on AWS. AWS itself is first
touched by that refresh, by the start-up SSO check, or by a command; the Messages route's credentials are built on the
first request.

## Discovery

Discovery runs the AWS CLI with the configured `profile` and `regions`, and always starts with
`aws sts get-caller-identity`, which also gives the account id. Then, by mode:

- **System:** `aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED`, paginated per region. Only entries
  whose ARN or name mentions Claude are kept, and each is read with `GetInferenceProfile`.
- **Tag:** `aws resourcegroupstaggingapi get-resources --resource-type-filters bedrock:application-inference-profile`,
  filtered by `tagKey`/`tagValue` and, only when configured, the active tag. Each match is read with
  `GetInferenceProfile`.
- **Explicit:** `GetInferenceProfile` for each `profiles` entry; no tag call and no system listing.

Only `ACTIVE` profiles are listed. The foundation model is read from the profile's model ARN; a profile that routes to
another inference profile is followed, up to two levels, and `GetFoundationModel` is never called.

A successful catalog is cached for 24 hours in `${XDG_CACHE_HOME:-~/.cache}/jig-bedrock/catalog.json`, written with private
permissions and an atomic rename. Your cache folder may be a link (to another disk, say) and is followed; the package's own
`jig-bedrock` folder and the file in it must not be links. The cache records the AWS profile, regions and discovery settings, so a changed setting discards it; a
changed account is detected at the next discovery and the file is removed. Until a background refresh finishes, the
cached models stay in `/model`. `/bedrock-refresh` forces a new run.

## Routes

A default install uses Converse for system-defined profiles and Messages for application inference profiles; `api` can
force either. There are two routes to the same Claude models:

- **Messages.** Pi's Anthropic Messages client calls
  `https://bedrock-runtime.<region>.amazonaws.com/anthropic/v1/messages`. The signing fetch removes the client's
  API-key headers (`x-api-key`, `authorization`) and signs each request with SigV4, using the credentials the AWS SDK
  resolves for the configured profile.
- **Converse.** Pi's own Bedrock stream uses the AWS SDK's `ConverseStream` operation at the bedrock-runtime endpoint.

A profile is put on Messages only when `api` is `messages` (the default), it is an **application** inference profile, and
its foundation model is an Anthropic model. System-defined profile ids use Converse, because they are not application
inference-profile ARNs. Every other model uses Converse, and `api: "converse"` puts every model there. Both routes
stream.

On Messages the tools array stays stable, so a changed tool list does not break the prompt cache; on Converse it does.
The footer and spend figures are the same on both.

## Model ids

Each profile is a model in `/model`. The id starts as the slug of Pi's registry name, such as `claude-sonnet-5-5`, and
profiles whose foundation model resolves to the same name share that slug. One keeps the bare id; the others get
a short geography suffix such as `-global` or `-eu`. A collision adds the region, and the old
`--<region>--<profile id>` form is kept as an alias. Their menu name adds the region and the profile name.

The bare id goes to the first system-defined profile by geography: the prefix of the first configured region (for
example `us.`), then `global.`, then the rest in region order. With no system-defined profile, an application profile
keeps the bare id only when it is the model's only profile; two application profiles are both suffixed. A session saved
under another provider still selects the model by its ARN.

A profile whose foundation model is not in Pi's registry is not listed; `/bedrock models` gives the reason after the
usable rows. A model with no price is listed, marked **no price**, and its replies count as unpriced. Nothing about
unusable rows is shown at startup.

## Spend and the footer

After every assistant reply from this provider, the extension appends one line to its monthly JSONL record under
`${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/spend/`. The record has the time, session id, short model id, region, route,
four token counts, Pi's computed cost and a priced flag; it has no prompt, ARN, account id or profile.

`ctx.ui.setStatus("jig-bedrock", …)` shows the month and this machine's priced total, for example `Nov $12.40`; with a
`monthlyBudgetUsd` it adds `/ $200`. A trailing `+` marks a month with an unpriced reply. The status clears when another
provider's model is selected. It is set at session start and after each reply, only when `ctx.hasUI` is true.

The budget is a display figure, not an AWS limit. The first reply over 80% and over 100% each produce one notice; the
state file under the same spend folder keeps those notices to once per month per machine, and a session that starts over
100% gets its own one-line reminder. Requests are never blocked.

An optional `spendCommand` (argv, no shell) prints `{ "month": "2026-11", "spentUsd": 203.4 }`; it is run at most once
every 10 minutes and at `/bedrock usage`, with the configured AWS profile and first region. While it works, the footer and
budget use its figure; on failure the local record is used and `/bedrock doctor` names the reason.
