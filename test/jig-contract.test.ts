// The contract with the published @clawdbuilder/jig (a test-only devDependency): the global symbols jig-bedrock looks up
// and the two `config` calls it makes must still exist in the package Dependabot pins. The dependency never ships.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const JIG = join(ROOT, "node_modules", "@clawdbuilder", "jig");

function readJig(path: string): string {
    return readFileSync(join(JIG, path), "utf8");
}

test("the global API symbols are the ones Jig publishes", () => {
    const jigClient = readJig("plugins/jig-core/src/client.ts");
    const ours = readFileSync(join(ROOT, "src", "jig", "client.ts"), "utf8");
    for (const symbol of ["jig.core.api/v1", "jig.core.pending/v1"]) {
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`Symbol\\.for\\("${escaped}"\\)`);
        assert.match(jigClient, pattern, `Jig publishes ${symbol}`);
        assert.match(ours, pattern, `jig-bedrock looks up ${symbol}`);
    }
});

test("Jig's config API still has the two calls this package makes", () => {
    const contract = readJig("plugins/jig-core/src/contract.ts");
    assert.match(
        contract,
        /registerSection\(\s*name: string,\s*validate: \(raw: unknown\) => readonly string\[\],\s*options\?: \{[^}]*\},\s*\): void;/s,
        "registerSection(name, validate, options) is still there",
    );
    assert.match(contract, /section\(name: string\): unknown;/, "section(name) is still there");
});

test("the Jig dependency is test-only and stays out of the published tarball", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
    };
    assert.ok(manifest.devDependencies?.["@clawdbuilder/jig"], "Jig is a devDependency, not a runtime one");
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
    const paths = entries.flatMap((entry) => {
        const files = (entry as { files?: Array<{ path?: unknown }> }).files ?? [];
        return files.flatMap((file) => (typeof file.path === "string" ? [file.path] : []));
    });
    assert.equal(
        paths.some((path) => path.startsWith("node_modules/")),
        false,
        "nothing from node_modules is published",
    );
});
