#!/usr/bin/env bash
set -euo pipefail

title="Scheduled CI failed"
run_url="${RUN_URL:?RUN_URL is required}"
body="The scheduled run failed: ${run_url}. Fix it before the next release."

number="$(
  gh issue list --state open --search "${title} in:title" --json number,title \
    --jq '.[] | select(.title == "Scheduled CI failed") | .number' | head -n1
)"
if [ -n "${number}" ]; then
  gh issue comment "${number}" --body "${body}"
else
  gh issue create --title "${title}" --body "${body}"
fi
