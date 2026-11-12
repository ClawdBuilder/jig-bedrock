# Settings

`bedrock.json` and the `JIG_BEDROCK_*` variables. `/bedrock settings` shows each value and its source.

## Where settings come from

The package reads `~/.pi/agent/bedrock.json` (or `PI_CODING_AGENT_DIR/bedrock.json`), then the environment on top. Nothing is required.

```json
{ "profile": "my-profile", "regions": ["us-east-1"] }
```

Edit the file, or run `/bedrock set <key> <value>` and `/bedrock unset <key>`. `set` checks first, writes mode 0600, and applies at once where it can. Lists are comma separated. An unknown key warns; a bad value stops the provider, but `/bedrock settings`, `set` and `unset` still work.

From 0.2.x, `/bedrock migrate` copies the `bedrock` section of `jig.json` to `bedrock.json`, once, and never overwrites.

## Every setting

| Setting            | Type                         | Default                             | Environment variable    | Meaning                                                                |
| ------------------ | ---------------------------- | ----------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `presets`          | object                       | unset                               | none                    | Named sets of profile, discovery, route, budget and spend settings.    |
| `preset`           | string                       | unset                               | `JIG_BEDROCK_PRESET`    | Active preset name.                                                    |
| `profile`          | string                       | unset                               | `JIG_BEDROCK_PROFILE`   | AWS profile for discovery, requests and sign-in.                       |
| `regions`          | list                         | `["us-east-1"]`                     | `JIG_BEDROCK_REGIONS`   | Regions to search, 1 to 16; the first picks the plain id.              |
| `tagKey`           | string                       | unset                               | `JIG_BEDROCK_TAG_KEY`   | Tag name for tag mode; use with `tagValue`.                            |
| `tagValue`         | string                       | unset                               | `JIG_BEDROCK_TAG_VALUE` | Tag value for tag mode.                                                |
| `activeTagKey`     | string                       | unset                               | none                    | Second tag name; use with `activeTagValue`.                            |
| `activeTagValue`   | string                       | unset                               | none                    | Second tag value.                                                      |
| `profiles`         | list                         | unset                               | none                    | Explicit inference-profile ARNs or ids, up to 256.                     |
| `team`             | string                       | unset                               | `JIG_BEDROCK_TEAM`      | 0.2.x short tag form, read once. Do not combine with `tagKey`.         |
| `api`              | `"messages"` or `"converse"` | `"messages"`                        | none                    | `converse` puts every model on Converse.                               |
| `converseModels`   | list of short ids            | unset                               | none                    | Models that stay on Converse.                                          |
| `messagesModels`   | list of short ids            | unset                               | none                    | Models forced onto Messages; not both lists.                           |
| `monthlyBudgetUsd` | number                       | unset                               | none                    | Display budget; not an AWS limit and never blocks.                     |
| `spendCommand`     | argv list                    | unset                               | none                    | Program that prints spend JSON; see [Spend command](spend-command.md). |
| `ssoLoginCommand`  | argv list                    | `aws sso login --profile {profile}` | none                    | The sign-in program; `{profile}` is replaced.                          |
| `signInAtStart`    | boolean                      | `false`                             | none                    | `true` renews an expired SSO sign-in at Pi start.                      |
| `browser`          | string                       | unset                               | none                    | Program that opens the sign-in address.                                |
| `debug`            | boolean                      | `false`                             | `JIG_BEDROCK_DEBUG=1`   | One private JSON line per request, discovery or repair.                |

`set` and `unset` change one key at a time. A model cannot be in both `converseModels` and `messagesModels`.

## Presets

A preset may hold `profile`, `regions`, `tagKey`, `tagValue`, `activeTagKey`, `activeTagValue`, `profiles`, `team`, `api`, `converseModels`, `messagesModels`, `monthlyBudgetUsd` and `spendCommand`. `ssoLoginCommand`, `signInAtStart`, `browser` and `debug` stay top level.

A preset name starts with a letter or digit, then up to 39 letters, digits, dots, underscores or hyphens. `JIG_BEDROCK_PRESET` wins over `preset`; with neither, the top level applies.

Precedence for every preset key: environment variable, active preset, top-level file, then the AWS-profile fallbacks below. `/bedrock use` switches now; `/bedrock preset add` snapshots the current settings; `/bedrock preset remove` deletes one.

## Which AWS profile is used

When `profile` is unset, the first of these wins:

| Order | Source                             |
| ----- | ---------------------------------- |
| 1     | `profile` or `JIG_BEDROCK_PROFILE` |
| 2     | The AWS profile chosen at `/login` |
| 3     | `AWS_PROFILE`                      |
| 4     | `AWS_DEFAULT_PROFILE`              |
| 5     | The AWS profile named `default`    |
| 6     | The environment credential chain   |

An explicit choice never falls back when it is missing. `/bedrock doctor` names the missing AWS profile.

## The three ways models are found

| Way            | Settings              | What it uses                                                     |
| -------------- | --------------------- | ---------------------------------------------------------------- |
| AWS-defined    | no tag, no `profiles` | Every AWS-defined Claude inference profile in `regions`.         |
| By tag         | `tagKey`, `tagValue`  | Application inference profiles with the tag; any Pi-known model. |
| Listed by hand | `profiles`            | Exact ARNs or ids; AWS-defined is Claude only.                   |

[How it works](how-it-works.md#how-models-are-found) has the calls and limits.

## Sign-in methods

Requests use the AWS SDK chain; discovery uses the AWS CLI. The AWS profile must work in both.

| You have                      | Requests and discovery | Repaired | Real AWS                          |
| ----------------------------- | ---------------------- | -------- | --------------------------------- |
| SSO                           | yes                    | yes      | yes                               |
| Keys in an AWS profile        | yes                    | no       | yes                               |
| Keys in the environment       | yes                    | no       | yes                               |
| Assumed role                  | yes                    | no       | timed out on 0.2.4; not run since |
| `credential_process`          | yes                    | no       | no                                |
| Web identity or instance role | requests only          | no       | no                                |
| Bedrock API key               | built-in provider only | no       | no                                |

“No” in the last column means tested with fakes only. This package hides a Bedrock API key from its own Converse requests; Pi's built-in provider still sees it.

## Other variables

| Variable                             | Use                                              |
| ------------------------------------ | ------------------------------------------------ |
| `PI_CODING_AGENT_DIR`                | Moves `bedrock.json`.                            |
| `XDG_STATE_HOME`                     | Moves spend and the debug log.                   |
| `XDG_CACHE_HOME`                     | Moves the catalog.                               |
| `AWS_CONFIG_FILE`                    | The AWS config file `/login` writes.             |
| `AWS_PROFILE`, `AWS_DEFAULT_PROFILE` | An AWS profile when `profile` is unset.          |
| `BROWSER`                            | Opens the sign-in address.                       |
| `PI_CACHE_RETENTION`                 | Pi's cache lifetime; Messages ignores it.        |
| `NO_COLOR`, `TERM`, `LANG`, `LC_ALL` | `NO_COLOR` removes colour; dumb terms use words. |

## Files on disk

| Path                                                                                          | What it is                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `~/.pi/agent/bedrock.json` for `pi`; `~/.jig` for `jig` (`PI_CODING_AGENT_DIR` or `JIG_HOME`) | Your settings and `/login` choice.                                                         |
| `~/.cache/jig-bedrock/catalog-<hash>.json` (`XDG_CACHE_HOME`)                                 | The model lists, one per AWS profile and discovery settings, at most 8; private, 24 hours. |
| `~/.local/state/jig-bedrock/` (`XDG_STATE_HOME`)                                              | `spend/`, `debug.log`, `sso-runtime/`.                                                     |
| `~/.aws/config.jig-bedrock-backup-<time>`                                                     | Up to five backups before `/login` adds an AWS profile.                                    |

The AWS profiles `/login` added stay in `~/.aws/config`. Pi's `auth.json` keeps the AWS profile's name until `/logout`. The model-list cache and spend record are per machine, shared by every Pi folder that runs jig-bedrock. The cache folder may be a link; `jig-bedrock` and the catalog files must not be. An older `catalog.json` is read until it ages out.

## Debug log

One JSON line per request, discovery or sign-in repair. It holds no prompt, reply, credential or authorization header. An account id becomes `<account>`; an ARN becomes its last segment. Unwritable lines are dropped.

[Back to the README](../README.md).
