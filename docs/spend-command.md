# Spend command

`spendCommand` is an optional argv array in `bedrock.json`. The package runs it without a shell, at most once every ten
minutes and at `/bedrock usage`. Its environment has the settings' `AWS_PROFILE` and first region as `AWS_REGION` and
`AWS_DEFAULT_REGION`. It must print one JSON object and nothing else:

```json
{ "month": "2026-11", "spentUsd": 203.4 }
```

`month` must be the current UTC month; `spentUsd` is a non-negative number. A failure, a timeout (30 seconds) or any other
output leaves the local figure in use, and `/bedrock doctor` says why.

## Ten-line example

```sh
#!/bin/sh
# Save as ~/bin/my-bedrock-spend and chmod +x.
# This example asks an internal billing endpoint; replace the URL with your own.
month=$(date -u +%Y-%m)
total=$(curl -fsS "https://billing.example.internal/bedrock?month=$month" | jq -r .total_usd)
printf '{"month":"%s","spentUsd":%s}\n' "$month" "$total"
```

```json
{ "bedrock": { "spendCommand": ["~/bin/my-bedrock-spend"] } }
```

The command is never run through a shell, so `~` is not expanded by the package; use an absolute path or a name on
`PATH`. It is your command: it may count other machines and tools, but it is still a display figure, not an AWS limit.
