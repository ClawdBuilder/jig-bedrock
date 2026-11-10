# Settings

Every setting of jig-bedrock, its type, its default, its environment variable and what it means. Read this page before
you edit `bedrock.json` by hand. `/bedrock settings` shows the same list with each value and where it comes from
(default, file or environment).

## Where settings come from

The package reads `~/.pi/agent/bedrock.json` (in the folder `PI_CODING_AGENT_DIR` names, if you set it), then applies the
environment variables below on top. The file holds the keys at the top level; a file that wraps them in a `bedrock`
object is still read. Nothing is required: with no file, the defaults apply.

```json
{ "profile": "my-profile", "regions": ["us-east-1"] }
```

You can change a setting in two ways: edit the file, or run `/bedrock set <key> <value>` (and `/bedrock unset <key>`).
`set` checks the value first, writes the file with mode 0600, and applies it at once where it can. Lists are comma
separated: `/bedrock set regions us-east-1,eu-west-1`.

An unknown key is ignored, with a warning that names the key. A bad value for a known key stops the provider and names
the field; `/bedrock`, with `settings`, `set` and `unset`, keeps working so you can repair it from inside Pi.

If you used 0.2.x, your settings may be in the `bedrock` section of a file called `jig.json` in the agent folder. The
first session says so; `/bedrock migrate` copies that section to `bedrock.json`, once, and never overwrites an existing
file.

## Every setting

| Setting            | Type                         | Default                                         | Environment variable                    | Meaning                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------- | ----------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`          | string                       | unset                                           | `JIG_BEDROCK_PROFILE`                   | The AWS profile for discovery, requests and sign-in. Unset means the choice made at `/login`, then the AWS environment (see below).                                                                                                                      |
| `regions`          | list of strings              | `["us-east-1"]`                                 | `JIG_BEDROCK_REGIONS` (comma separated) | The AWS regions to look in, 1 to 16 of them. The first one also decides which geography keeps the plain model id.                                                                                                                                        |
| `tagKey`           | string                       | unset                                           | `JIG_BEDROCK_TAG_KEY`                   | Tag mode: the tag name an application inference profile must carry. Set it together with `tagValue`.                                                                                                                                                     |
| `tagValue`         | string                       | unset                                           | `JIG_BEDROCK_TAG_VALUE`                 | Tag mode: the tag value to match.                                                                                                                                                                                                                        |
| `activeTagKey`     | string                       | unset                                           | none                                    | Tag mode: a second tag that must also match. Set it together with `activeTagValue`.                                                                                                                                                                      |
| `activeTagValue`   | string                       | unset                                           | none                                    | Tag mode: the value of the second tag.                                                                                                                                                                                                                   |
| `profiles`         | list of strings              | unset                                           | none                                    | Explicit mode: inference-profile ARNs or ids, up to 256. When set, no tag search and no listing run.                                                                                                                                                     |
| `team`             | string                       | unset                                           | `JIG_BEDROCK_TEAM`                      | The 0.2.x short form of tag mode, read for one more release. It means `tagKey` `Team`, `tagValue` this value, and the second tag `Active` = `true`. `/bedrock migrate` rewrites it into the generic keys. Do not combine it with `tagKey` or `tagValue`. |
| `api`              | `"messages"` or `"converse"` | `"messages"`                                    | none                                    | `converse` puts every model on Converse. `messages` does not force Messages: each Claude model still gets the route [the rule](how-it-works.md#which-route-a-model-gets) picks for it.                                                                   |
| `converseModels`   | list of short model ids      | unset                                           | none                                    | Models that stay on Converse, such as `claude-opus-5`.                                                                                                                                                                                                   |
| `messagesModels`   | list of short model ids      | unset                                           | none                                    | Models that go on Messages even where the installed Pi does not list tool changes for them: use it for a model newer than your Pi. A model cannot be in both lists.                                                                                      |
| `monthlyBudgetUsd` | number above 0               | unset                                           | none                                    | The budget the footer shows next to the month's spend. It is a figure to compare with, not an AWS limit, and it never blocks a request. `/bedrock budget` sets it.                                                                                       |
| `spendCommand`     | list of strings (argv)       | unset                                           | none                                    | A program, with no shell, that prints this month's spend as JSON. See [Spend command](spend-command.md).                                                                                                                                                 |
| `ssoLoginCommand`  | list of strings (argv)       | `["aws","sso","login","--profile","{profile}"]` | none                                    | The program that signs in. `{profile}` is replaced by the AWS profile's name; no other placeholder exists.                                                                                                                                               |
| `signInAtStart`    | boolean                      | `false`                                         | none                                    | `true` renews an expired SSO sign-in when Pi starts, which may open a browser. `false` leaves it to the first failing request or `/bedrock login`.                                                                                                       |
| `browser`          | string                       | unset                                           | none                                    | The program that opens the sign-in address: a full path, or a name on your PATH, with no arguments. Unset on WSL means the Windows browser.                                                                                                              |
| `debug`            | boolean                      | `false`                                         | `JIG_BEDROCK_DEBUG=1`                   | Append one line per request to `debug.log` in the state folder. It never holds credentials, prompt text or account ids.                                                                                                                                  |

A key must be spelled exactly as above. Three settings start programs: `ssoLoginCommand`, `browser` and `spendCommand`. The package
runs them without a shell.

## Which AWS profile is used

When `profile` is unset, the package takes the first of these that exists:

1. `profile` in the file, or `JIG_BEDROCK_PROFILE` (the variable wins over the file);
2. the AWS profile chosen at `/login`, which Pi keeps as its credential for this provider;
3. `AWS_PROFILE`;
4. `AWS_DEFAULT_PROFILE`;
5. the AWS profile called `default`, when your AWS config or credentials file has one;
6. otherwise the AWS credential chain of the environment (keys in variables, a container role or an instance role).

An explicit choice is never replaced by a lower one, even when it is missing: a name that is in neither your AWS config
nor your credentials file gives no models, and `/bedrock doctor` says which name is wrong.

## The three ways models are found

The settings choose one way. [How it works](how-it-works.md#how-models-are-found) says what each one calls.

1. **AWS-defined (default).** No tag setting and no `profiles`: every AWS-defined Claude inference profile in `regions`.
   It includes `global.` ones, whose price and data residency differ.
2. **By tag.** `tagKey` and `tagValue` (with the optional `activeTagKey` and `activeTagValue`) select application
   inference profiles that carry the tag.
3. **Listed by hand.** `profiles` names them.

## Sign-in methods

Requests use the AWS SDK's credential chain; discovery uses the AWS CLI with `--profile`, so the AWS profile must work
in both.

| What you have                                        | Requests and discovery                                      | Sign-in repair | Run against real AWS                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| SSO (IAM Identity Center)                            | yes                                                         | yes            | yes                                                                                               |
| Access keys in the AWS profile                       | yes                                                         | no             | yes (temporary keys)                                                                              |
| Access keys in environment variables, no AWS profile | yes                                                         | no             | yes                                                                                               |
| Assumed role (`role_arn`)                            | yes                                                         | no             | timed out at 90 seconds on 0.2.4, because each AWS CLI call assumes the role again; not run since |
| `credential_process`                                 | yes                                                         | no             | no                                                                                                |
| Web identity or instance role                        | requests only, unless an AWS profile the CLI can use exists | no             | no                                                                                                |
| Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`)         | not used by this package; Pi's built-in provider takes it   | no             | no                                                                                                |

"No" in the last column means the SDK and the CLI support it and the tests fake it, but no real run of this package
used it. A Bedrock API key in the environment is hidden from this package's own Converse requests, so it never
replaces the AWS profile, and Pi's built-in provider still sees it.

## Other variables the package reads

| Variable                             | Used for                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CODING_AGENT_DIR`                | Moves Pi's agent folder, and with it `bedrock.json`.                                                                                                 |
| `XDG_STATE_HOME`                     | Moves the state folder (default `~/.local/state`) that holds the spend record and the debug log.                                                     |
| `XDG_CACHE_HOME`                     | Moves the cache folder (default `~/.cache`) that holds the catalog.                                                                                  |
| `AWS_CONFIG_FILE`                    | The AWS config file `/login` adds a new AWS profile to (default `~/.aws/config`).                                                                    |
| `AWS_PROFILE`, `AWS_DEFAULT_PROFILE` | An AWS profile when `profile` is unset (see above).                                                                                                  |
| `BROWSER`                            | The program that opens the sign-in address, when `browser` is unset.                                                                                 |
| `PI_CACHE_RETENTION`                 | Pi's own cache lifetime. The package does not change it. It has no effect on the Messages route, which sends only the 5-minute lifetime.             |
| `NO_COLOR`, `TERM`, `LANG`, `LC_ALL` | With `NO_COLOR` set, `TERM=dumb` or a locale that is not UTF-8, command output uses the words ok, warning, failure and skipped instead of the marks. |

[Back to the README](../README.md).

## Debug log

Off by default. With `JIG_BEDROCK_DEBUG=1` in the environment or `"debug": true` in `bedrock.json`, this package appends one
JSON line to `${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/debug.log` when each request ends, when each model discovery
run ends and when each sign-in repair ends. With it off nothing is written and no file or folder is made.

A request line has `time`, `event: "request"`, `model` (the short id), `region`, `route` (`messages` or `converse`), `status` and
`requestId` when AWS answered, `ms`, the token counts `input`, `output`, `cacheRead` and `cacheWrite` when known, and for a
failure `error` (the AWS error name) and `message` (its first 300 characters). `attempts` appears when the client had to
try more than once. A discovery line has `event: "discovery"`, `mode`, `regions`, `models`, `ms`, `status`, and `cached: true`
when a fresh catalog cache answered without asking AWS; a sign-in line has `event: "sign-in"`, `source`, `outcome` and `ms`.

A prompt, a reply, a tool argument, a credential, a signature and an authorization header are never read or written. In a
message an AWS account id becomes `<account>` and a full ARN becomes its last path segment. The file is private (mode 0600, in a
0700 folder). When it passes 5 MB it is renamed to `debug.log.1`, replacing an older one, and a new file starts. A log that
cannot be written is dropped; it never fails a request.
