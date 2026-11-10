// The AWS SDK's credential chain is this package's own dependency: it loads from this package's node_modules, with no Pi install
// involved, and nothing in src/ looks for one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

test("the SDK is a dependency with an exact version, and the package imports it lazily", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.match(manifest.dependencies["@aws-sdk/credential-provider-node"], /^\d+\.\d+\.\d+$/);
    for (const file of readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })) {
        if (!file.endsWith(".ts")) continue;
        const text = readFileSync(path.join(root, "src", file), "utf8");
        assert.doesNotMatch(
            text,
            /^import[^\n]*["']@aws-sdk\//m,
            `${file} imports the SDK at module load, which slows Pi's start-up`,
        );
    }
});

test("nothing in src/ looks for Pi's install", () => {
    for (const file of readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })) {
        if (!file.endsWith(".ts")) continue;
        const text = readFileSync(path.join(root, "src", file), "utf8");
        assert.doesNotMatch(text, /pi-host|PI_HOST_DIR|findPiHost/, file);
    }
    assert.throws(() => readFileSync(path.join(root, "src/pi-host.ts")), /ENOENT/);
});

test("the credential chain loads from this package's node_modules, with no Pi on the path", () => {
    const sdk = createRequire(path.join(root, "src/credential-provider.ts")).resolve(
        "@aws-sdk/credential-provider-node",
    );
    assert.ok(sdk.startsWith(path.join(realpathSync(path.join(root, "node_modules")), path.sep)), sdk);

    // A fresh Node in an empty folder: no PI_HOST_DIR, no Pi beside it, only this Node on the PATH, and keys in the
    // environment so the chain resolves with no file and no network.
    const dir = mkdtempSync(path.join(tmpdir(), "bedrock-own-sdk-"));
    try {
        const script = path.join(dir, "load.mjs");
        writeFileSync(
            script,
            `import { loadCredentialProvider } from ${JSON.stringify(pathToFileURL(path.join(root, "src/credential-provider.ts")).href)};
const provider = await loadCredentialProvider();
const credentials = await provider({})();
console.log(JSON.stringify({ kind: typeof provider, key: credentials.accessKeyId }));
`,
        );
        const output = execFileSync(process.execPath, [script], {
            cwd: dir,
            encoding: "utf8",
            env: {
                PATH: path.dirname(process.execPath),
                HOME: dir,
                AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
                AWS_SECRET_ACCESS_KEY: "fixture-secret",
            },
        });
        assert.deepEqual(JSON.parse(output), { kind: "function", key: "AKIAFIXTURE" });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
