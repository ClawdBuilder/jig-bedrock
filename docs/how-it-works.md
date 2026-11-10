# How it works

What happens between a setting and a streamed reply: discovery, the two routes to Claude, model ids, and the usage
footer. Read it when a profile is missing, a request fails, or a model shows an unexpected name.

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

A successful catalog is cached for 24 hours in `~/.cache/jig-bedrock/catalog.json`, written with private permissions and
an atomic rename. The cache records the AWS profile, regions and discovery settings, so a changed setting discards it; a
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
The footer and usage figures are the same on both.

## Model ids

Each profile is a model in `/model`. The id starts as the slug of Pi's registry name, such as `claude-sonnet-5-5`, and
profiles whose foundation model resolves to the same name share that slug. One keeps the bare id; the others get
`--<region>--<profile id>`, such as `claude-sonnet-5-5--us-east-1--abc123de`. Their menu name adds the region and the
profile name.

The bare id goes to the first system-defined profile by geography: the prefix of the first configured region (for
example `us.`), then `global.`, then the rest in region order. With no system-defined profile, an application profile
keeps the bare id only when it is the model's only profile; two application profiles are both suffixed. A session saved
under another provider still selects the model by its ARN.

A profile whose foundation model is not in Pi's registry, or whose model has no price, is not listed. `/bedrock-profiles`
gives the reason, and the startup notice names the first.

## The usage footer

The provider runs the spend command with `--monthly`; without one there is nothing to show. The budget and footer are
part of this package's own interface, not another program's event bus.

The label is `<Mon> $spend / $budget`, for example `Oct $203 / $200`. A trailing `+` on the spend means some usage had no
price, so the figure is a lower bound. From 80% of `monthlyBudgetUsd` the part turns to a warning, and at or over the
budget it is an error. With no `monthlyBudgetUsd` it shows the spend alone. Months roll over in UTC, and a figure from
another month is not shown.

The figure is cached in `~/.cache/jig-bedrock/budget.json`. While a Bedrock model is selected in the TUI, the provider
refreshes it in the background at most every five minutes; a failed refresh keeps the last figure.
`/bedrock-usage monthly` shows the same figure with its per-model rows, and `/bedrock-stats` compares it with the local
session records.

[Back to the README](../README.md).
