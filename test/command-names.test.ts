// 0.5.0 removed the old command names; only the current /bedrock command remains.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const OLD = /\/(?:aws-login|bedrock-refresh|bedrock-doctor|bedrock-usage|bedrock-stats|bedrock-profiles)\b/;

test("no source or page names a removed command, and no alias is registered", () => {
    const root = join(import.meta.dirname, "..");
    const bad: string[] = [];
    for (const folder of ["src", "docs"]) {
        for (const name of readdirSync(join(root, folder)).filter((entry) => /\.(ts|md)$/.test(entry))) {
            const file = join(root, folder, name);
            readFileSync(file, "utf8")
                .split("\n")
                .forEach((line, index) => {
                    if (OLD.test(line)) bad.push(`${folder}/${name}:${index + 1}: ${line.trim()}`);
                    if (
                        /registerCommand\("(?:aws-login|bedrock-refresh|bedrock-doctor|bedrock-usage|bedrock-stats|bedrock-profiles)"/.test(
                            line,
                        )
                    )
                        bad.push(`${folder}/${name}:${index + 1}: alias registration`);
                });
        }
    }
    const readme = readFileSync(join(root, "README.md"), "utf8");
    if (OLD.test(readme)) bad.push("README.md names a removed command");
    assert.deepEqual(bad, []);
});
