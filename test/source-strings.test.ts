// Strings in src/ get the same review as Markdown: file-key names, "AWS profile" qualification, and markers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "src");
const files = readdirSync(root).filter((name) => name.endsWith(".ts") && name !== "markers.ts");
const sources = files.map((name) => ({ name, text: readFileSync(join(root, name), "utf8") }));

test("no user-visible string uses a bare profile or a bedrock. key prefix", () => {
    const bad: string[] = [];
    for (const { name, text } of sources) {
        for (const phrase of ['"the profile', '"a profile', '"configured profile', "'the profile", "'a profile"])
            if (text.includes(phrase)) bad.push(`${name}: ${phrase}`);
        const prefix = /bedrock\.(?:profile|regions|browser|api|debug|team|spendCommand|monthlyBudgetUsd)\b/.exec(text);
        if (prefix) bad.push(`${name}: ${prefix[0]}`);
    }
    assert.deepEqual(bad, []);
});

test("no literal check or dash marker remains outside markers.ts", () => {
    const bad: string[] = [];
    for (const { name, text } of sources) {
        if (/[✓✗–]/.test(text)) bad.push(name);
        if (/"!"|`!"|"! /.test(text)) bad.push(`${name}: literal warning mark`);
    }
    assert.deepEqual(bad, []);
});
