# Settings

`bedrock.json` and the `JIG_BEDROCK_*` variables. `/bedrock settings` shows each value and its source.

## Where settings come from

The package reads `~/.pi/agent/bedrock.json` (or `PI_CODING_AGENT_DIR/bedrock.json`), then the environment on top. Nothing is required.

```json
{ "profile": "my-profile", "regions": ["us-east-1"] }
```

Edit the file, or run `/bedrock set <key> <value>` and `/bedrock unset <key>`. A save replaces the running settings at once: a changed profile, region, tag or explicit list reloads the models, and `api`, `converseModels` or `messagesModels` re-route them. `unset` also takes effect at once. Lists are comma separated; a value with spaces is quoted (`/bedrock set tagValue "Cost Center"`); booleans take true/false, or on/off and yes/no. A region name is checked when it is set: a typo is refused with the nearest names. An unknown key warns; a bad value stops the provider, but `/bedrock settings`, `set` and `unset` still work.

From 0.2.x, `/bedrock migrate` copies the `bedrock` section of `jig.json` to `bedrock.json`, once, and never overwrites.

## Every setting

| Setting            | Type                                 | Default                             | Environment variable    | Meaning                                                                |
| ------------------ | ------------------------------------ | ----------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `presets`          | object                               | unset                               | none                    | Named sets of profile, discovery, route, budget and spend settings.    |
| `preset`           | string                               | unset                               | `JIG_BEDROCK_PRESET`    | Preset a new session opens on when nothing is restored.                |
| `allPresetModels`  | boolean                              | `true`                              | none                    | `false` = one plain provider carrying the preset's settings (0.6.3).   |
| `discovery`        | `"aws-defined"`, `"tag"` or `"list"` | unset                               | none                    | How models are found; unset infers it from the keys.                   |
| `profile`          | string                               | unset                               | `JIG_BEDROCK_PROFILE`   | AWS profile for discovery, requests and sign-in.                       |
| `regions`          | list                                 | `["us-east-1"]`                     | `JIG_BEDROCK_REGIONS`   | Regions to search, 1 to 16; the first picks the plain id.              |
| `tagKey`           | string                               | unset                               | `JIG_BEDROCK_TAG_KEY`   | Tag name for tag mode; use with `tagValue`.                            |
| `tagValue`         | string                               | unset                               | `JIG_BEDROCK_TAG_VALUE` | Tag value for tag mode.                                                |
| `activeTagKey`     | string                               | unset                               | none                    | Second tag name; use with `activeTagValue`.                            |
| `activeTagValue`   | string                               | unset                               | none                    | Second tag value.                                                      |
| `profiles`         | list                                 | unset                               | none                    | Explicit inference-profile ARNs or ids, up to 256.                     |
| `team`             | string                               | unset                               | `JIG_BEDROCK_TEAM`      | 0.2.x short tag form, read once. Do not combine with `tagKey`.         |
| `api`              | `"messages"` or `"converse"`         | `"messages"`                        | none                    | `converse` puts every model on Converse.                               |
| `converseModels`   | list of short ids                    | unset                               | none                    | Models that stay on Converse.                                          |
| `messagesModels`   | list of short ids                    | unset                               | none                    | Models forced onto Messages; not both lists.                           |
| `monthlyBudgetUsd` | number                               | unset                               | none                    | Display budget; not an AWS limit and never blocks.                     |
| `spendCommand`     | argv list                            | unset                               | none                    | Program that prints spend JSON; see [Spend command](spend-command.md). |
| `ssoLoginCommand`  | argv list                            | `aws sso login --profile {profile}` | none                    | The sign-in program; `{profile}` is replaced.                          |
| `signInAtStart`    | boolean                              | `false`                             | none                    | `true` renews an expired SSO sign-in at Pi start.                      |
| `browser`          | string                               | unset                               | none                    | Program that opens the sign-in address.                                |
| `debug`            | boolean                              | `false`                             | `JIG_BEDROCK_DEBUG=1`   | One private JSON line per request, discovery or repair.                |

`set` accepts several key-value pairs and `unset` several keys in one command, for example `/bedrock set activeTagKey Active activeTagValue true`. A model cannot be in both `converseModels` and `messagesModels`.

## Presets

A preset may hold `profile`, `discovery`, `regions`, `tagKey`, `tagValue`, `activeTagKey`, `activeTagValue`, `profiles`, `team`, `api`, `converseModels`, `messagesModels`, `monthlyBudgetUsd` and `spendCommand`. `ssoLoginCommand`, `signInAtStart`, `browser` and `debug` stay top level.

When a tag lists profiles that split by another tag, `/login` offers the values of that tag as a second filter and saves `activeTagKey`/`activeTagValue`. Without a UI it lists all and says a second tag would narrow the result.

A model AWS refuses with AccessDenied is remembered for seven days per AWS profile and account and hidden from `/model`; `/bedrock models` lists it under “Refused by AWS for your role” with the date. `/bedrock refresh`, or “Try again” in the Models menu, tries it again. The next prompt is not swallowed: choose another model with `/model`.

Each preset is its own Pi provider, `jig-bedrock-<preset>`, so every preset's models appear in `/model` at once, with that id in the bracket at the end of the row; the top-level settings stay the plain `jig-bedrock` provider. `/login` lists one Amazon Bedrock entry per preset, and signing in on one saves the AWS profile and discovery into that preset. A saved default names the provider it was saved from, so `/model` then Ctrl+S keeps it.

A preset name starts with a letter or digit, then up to 39 letters, digits, dots, underscores or hyphens. `preset` names the model a new session opens on when Pi restored no model and no saved default exists; it never changes the plain provider's settings. `JIG_BEDROCK_PRESET` narrows the provider list to the plain provider plus that preset, and wins over nothing else.

```json
{
    "presets": {
        "work": { "profile": "company-profile", "team": "my-team", "monthlyBudgetUsd": 200 },
        "personal": { "profile": "my-profile", "regions": ["us-west-2"] }
    },
    "preset": "work"
}
```

`/bedrock use` lists the presets and switches to one by selecting a model of it: this session's last model for that provider, else Pi's saved default if it belongs to that provider, else its first. While its models are still arriving it starts the discovery and says so, changing nothing else. `/bedrock preset new` (or the Presets menu's `New preset…`) asks for a preset name, the AWS profile, discovery and regions with the same prompts as `/login`, saves the preset and switches to it; without a UI it says to use `/bedrock preset add <name>` or edit the file. `/bedrock preset add work` copies the settings in force into a new preset, registers it at once from the same cached catalog (no discovery) and selects its model; `/bedrock preset remove work` deletes it and unregisters its provider. The top-level settings are the row labelled `Top-level settings` at the top of the Presets menu, and `/bedrock use top` selects the top-level model; `top` cannot be a preset name. A preset inherits every top-level setting it does not name: one that sets only `profile` and `regions` still reads the top-level tag, and its row in the Presets menu says `by tag`. The footer shows the spend of the model in use, including this month's spend from before presets existed. In a second terminal, `JIG_BEDROCK_PRESET=work pi` gives it the plain provider plus `work`.

Setting `allPresetModels: false` returns to 0.6.3's shape: one plain `jig-bedrock` provider carries the `preset`/`JIG_BEDROCK_PRESET` settings, there is no provider per preset, and no extra discovery runs. Otherwise `JIG_BEDROCK_PRESET=work` shows only the plain provider and `work` in `/model`; an unknown name warns once and shows the plain provider.

`discovery` names the way models are found: `"aws-defined"` lists every AWS-defined Claude inference profile, `"tag"` needs `tagKey` and `tagValue`, and `"list"` needs `profiles`. A preset that sets `discovery` uses only its own discovery keys: it does not inherit a top-level `tagKey`, `tagValue`, `activeTagKey`, `activeTagValue`, `team` or `profiles`. A preset that does not set it inherits the top-level `discovery`; with neither set, the way is inferred from the keys as before. `/bedrock set discovery aws-defined` reloads the models at once, and `/login` saves the word for the choice it asks.

```json
{
    "discovery": "tag",
    "tagKey": "Team",
    "tagValue": "my-team",
    "presets": {
        "work": { "profile": "my-profile" },
        "personal": { "profile": "my-profile", "discovery": "aws-defined" }
    },
    "preset": "work"
}
```

Precedence for every preset key: environment variable, the preset being viewed, top-level file, then the AWS-profile fallbacks below. The scope of a command is the model in use: `/login` on `jig-bedrock-<preset>` saves the AWS profile and discovery into that preset, and `/bedrock set`, `unset` and `budget` write there too, not the top level.

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

| Way            | `discovery`     | Settings              | What it uses                                                     |
| -------------- | --------------- | --------------------- | ---------------------------------------------------------------- |
| AWS-defined    | `"aws-defined"` | no tag, no `profiles` | Every AWS-defined Claude inference profile in `regions`.         |
| By tag         | `"tag"`         | `tagKey`, `tagValue`  | Application inference profiles with the tag; any Pi-known model. |
| Listed by hand | `"list"`        | `profiles`            | Exact ARNs or ids; AWS-defined is Claude only.                   |

When `discovery` is unset, the way is inferred from the Settings column, as 0.6.2 did. `discovery` is a choice: `/login` writes the word for the mode chosen, and `/bedrock set discovery` changes it. A `"tag"` choice without `tagKey` and `tagValue`, and a `"list"` choice without `profiles`, are configuration errors that say what to add.

[How it works](how-it-works.md#how-models-are-found) has the calls and limits.

## Sign-in methods

Requests and discovery both use the AWS SDK credential chain, with the AWS profile's credentials. The AWS CLI is still needed for `aws sso login` and the AWS profile list (`aws configure list-profiles`).

| You have                      | Requests and discovery | Repaired      | Real AWS                                     |
| ----------------------------- | ---------------------- | ------------- | -------------------------------------------- |
| SSO                           | yes                    | yes           | yes                                          |
| Keys in an AWS profile        | yes                    | no            | yes                                          |
| Keys in the environment       | yes                    | no            | yes                                          |
| Assumed role                  | yes                    | over SSO only | yes (2026-11-16: discovery 23 s, request OK) |
| `credential_process`          | yes                    | no            | no                                           |
| Web identity or instance role | requests only          | no            | no                                           |
| Bedrock API key               | built-in provider only | no            | no                                           |

“No” in the last column means tested with fakes only. This package hides a Bedrock API key from its own Converse requests; Pi's built-in provider still sees it. Pi has no provider logout hook, so after `/logout` run `/bedrock unset profile`. For an assumed role, the credential chain assumes the role again through `source_profile`; `/bedrock login` renews the SSO source profile, and a role over keys is not renewed.

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
