# Spend command

By default the footer and the budget count the replies of this machine's Pi sessions. `spendCommand` is an optional
setting for when you want another figure, such as one that counts other machines and tools. It is a list of strings (an
argv) in `bedrock.json`. The package runs it without a shell, at most once every ten minutes and at `/bedrock usage`.

Its environment is the one Pi has, plus `AWS_PROFILE` (when an AWS profile is chosen), the first of your `regions` as
`AWS_REGION` and `AWS_DEFAULT_REGION`, and `NO_COLOR=1`. It must print one JSON object and nothing else, in at most
64 KiB:

```json
{ "month": "2026-11", "spentUsd": 203.4 }
```

`month` must be the current UTC month. `spentUsd` must be a number that is not negative. A failure, a run longer than
30 seconds, or any other output leaves this machine's figure in use, and `/bedrock doctor` says why.

While the command works, the footer and the budget use its figure, and `/bedrock usage` shows both, named "this
machine's Pi sessions" and "your spend command". It is still a figure to compare with, not an AWS limit: nothing is
blocked at the budget.

## Ten-line example

This example asks an internal billing endpoint and needs `curl` and `jq`. Replace the address with your own.

```sh
#!/bin/sh
# Save as ~/bin/my-bedrock-spend and chmod +x.
# This example asks an internal billing endpoint; replace the URL with your own.
month=$(date -u +%Y-%m)
total=$(curl -fsS "https://billing.example.internal/bedrock?month=$month" | jq -r .total_usd)
printf '{"month":"%s","spentUsd":%s}\n' "$month" "$total"
```

```json
{ "spendCommand": ["/home/me/bin/my-bedrock-spend"] }
```

The command is never run through a shell, so `~` is not expanded: use an absolute path, or a name on your `PATH`.

[Back to the README](../README.md).
