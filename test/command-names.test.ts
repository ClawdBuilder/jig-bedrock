// No user-facing text names a command that 0.3.0 replaced. The only old names left are the alias registrations.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const OLD = /\/(?:aws-login|bedrock-refresh|bedrock-doctor|bedrock-usage|bedrock-stats|bedrock-profiles)\b/;
const ALIAS =
    /registerCommand\("(?:aws-login|bedrock-refresh|bedrock-doctor|bedrock-usage|bedrock-stats|bedrock-profiles)"/;

test("no source text names an old command outside its alias registration", () => {
    const root = join(import.meta.dirname, "..", "src");
    const bad: string[] = [];
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".ts"))) {
        const file = join(root, name);
        readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, index) => {
                if (OLD.test(line) && !ALIAS.test(line)) bad.push(`${name}:${index + 1}: ${line.trim()}`);
            });
    }
    assert.deepEqual(bad, []);
});
