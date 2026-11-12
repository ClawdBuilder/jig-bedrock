# Spend command

`spendCommand` supplies another spend figure, such as one counting other machines. It is an argv list in `bedrock.json`; the package runs it without a shell, at most every ten minutes and at `/bedrock usage`.

It gets Pi's environment plus `AWS_PROFILE`, the first `regions` entry as `AWS_REGION` and `AWS_DEFAULT_REGION`, and `NO_COLOR=1`. It must print one JSON object, at most 64 KiB:

```json
{ "month": "2026-11", "spentUsd": 203.4 }
```

`month` is the current UTC month; `spentUsd` is zero or more. A failure, 30 seconds, or other output keeps this machine's figure; `/bedrock doctor` names the reason. The footer and `/bedrock usage` then show both figures. It is not an AWS limit and blocks nothing.

## Example

This asks an internal endpoint and needs `curl` and `jq`:

```sh
#!/bin/sh
month=$(date -u +%Y-%m)
total=$(curl -fsS "https://billing.example.internal/bedrock?month=$month" | jq -r .total_usd)
printf '{"month":"%s","spentUsd":%s}\n' "$month" "$total"
```

```json
{ "spendCommand": ["/home/me/bin/my-bedrock-spend"] }
```

No shell: `~` is not expanded. Use an absolute path or a name on `PATH`.

[Back to the README](../README.md).
