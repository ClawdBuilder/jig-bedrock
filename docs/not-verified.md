# Not verified

What has run against real AWS, what the tests fake, and what the repository checks before a merge.

## What has run against real AWS

Only the SSO sign-in and credential path has been tested against real AWS. Real-AWS tests are manual and need the user's
approval.

## What has not

- The exact Messages behaviour for a system-defined profile id. The package sends those profiles through Converse, so
  the Messages route never sees one.
- The response shapes of `ListInferenceProfiles` pagination and of system-profile model ARNs. The tests fake them from
  AWS documentation.
- IAM policy evaluation for a cross-region profile plus foundation-model permissions in every routing region.
- Credentials other than SSO: access keys, an assumed role, `credential_process`, and web identity or an instance role
  are supported by the SDK and CLI, but no real run in this package has used them.
- Pricing and model metadata for system-defined profiles, which come from Pi's registry; no live `GetFoundationModel`
  call is made.

## How it is checked

Unit tests use recorded shapes and a fake AWS CLI: `npm test` runs them, `npm run check` typechecks and lints, and
`npm run scan` looks for secrets and for company words supplied from outside the repository.

`npm run check:emails` checks the author and committer addresses in `origin/main..HEAD`, and `npm run scan` checks
the tree for secret shapes and for the same private words. CI passes the `SCAN_WORDS` secret to both steps as
`JIG_SCAN_WORDS_TEXT`; locally, `JIG_SCAN_WORDS_TEXT`, `JIG_SCAN_WORDS` or `~/.config/jig/scan-words.txt` supplies it.
A match fails the run, and the scan prints only the file and line, never the word. Without a list (a fork's CI), only
`noreply@example.com`, an address at `users.noreply.github.com`, and the maintainer's public address pass; any other
address warns and does not block the run. The optional pre-push hook is not installed: copy
`scripts/pre-push-commit-emails.sh` to `.git/hooks/pre-push` and make it executable.

[Back to the README](../README.md).
