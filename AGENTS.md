# Working in jig-bedrock

jig-bedrock is a public Pi package that turns AWS Bedrock inference profiles into Pi models. Never put company names, account ids, real AWS profile names, or machine paths in this repository; `npm run scan` enforces it.

## Commits

- Author every commit as `Jig Contributors <noreply@example.com>`.
- Keep the subject imperative and the change to one concern.

## Tests

- Use the fake AWS in `test/`; never call real AWS or run the real `aws` program.
- Keep tests deterministic: no network, no sleep past a short wait, no real credentials.
- Never print or log credentials, tokens, or authorization headers.
- Run `npm test`, `npm run check`, `npm run scan`, and `npm run check:packed` before saying done. All four must pass.
- A "Done when" line must be tried against a failing case, not only the happy one.

## Change a setting

Add the key to `src/config.ts` and its row to `docs/settings.md` together. `test/docs.test.ts` checks both directions.

## Add a command

Add the sub-command to `BEDROCK_SUBCOMMANDS`, the `HELP` text, the command handler, and the pages that list commands. `test/docs.test.ts` checks the pages against the list.

## Read more

- `docs/contributing.md`: diagrams, CI, releases.
- `docs/how-it-works.md`: routes, discovery, prompt cache, and the words used here.
- `docs/settings.md`: every setting, preset, and file on disk.
