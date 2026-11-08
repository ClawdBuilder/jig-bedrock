#!/bin/sh
# Optional local pre-push hook. Do not install this automatically:
#   cp scripts/pre-push-commit-emails.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
# It reads the private list exactly as the CI step does; without it, unknown addresses warn and the push continues.
set -eu
root=$(git rev-parse --show-toplevel)
exec node "$root/scripts/check-commit-emails.mjs"
