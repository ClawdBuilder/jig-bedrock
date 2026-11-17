// scripts/real-check-discovery.mjs is run by hand against a real AWS profile, so nothing else would notice if it stopped
// loading (it once imported a function that discovery no longer exports). These runs use the fake AWS over fetch: no
// network and no real credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/real-check-discovery.mjs");
const FAKE_AWS = pathToFileURL(resolve(ROOT, "test/support/fake-aws-http.ts")).href;

/** Runs the script in a scratch folder with fake static keys; `failing` names the fake AWS operation that answers 403. */
function run(t: TestContext, args: string[], failing = "") {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-real-discovery-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
        join(dir, "credentials"),
        "[fixture]\naws_access_key_id = fixture-access-key\naws_secret_access_key = fixture-secret-key\n",
    );
    writeFileSync(join(dir, "config"), "");
    const preload = join(dir, "preload.mjs");
    writeFileSync(
        preload,
        `import { fakeAwsHttp } from ${JSON.stringify(FAKE_AWS)};
const failing = process.env.FAKE_AWS_FAIL;
const denied = { status: 403, body: JSON.stringify({ message: "not authorized to perform: bedrock:ListInferenceProfiles" }) };
globalThis.fetch = fakeAwsHttp({ fail: (operation) => (operation === failing ? denied : undefined) }).fetch;
`,
    );
    return spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: dir,
            TMPDIR: dir,
            AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
            AWS_CONFIG_FILE: join(dir, "config"),
            AWS_EC2_METADATA_DISABLED: "true",
            FAKE_AWS_FAIL: failing,
        },
    });
}

test("--help prints the usage and exits 0, so the script at least loads", (t) => {
    const result = run(t, ["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: node scripts\/real-check-discovery\.mjs --profile/);
});

test("without --profile it exits 2", (t) => {
    const result = run(t, []);
    assert.equal(result.status, 2, result.stderr);
});

test("it counts the calls of an AWS-defined discovery against the fake AWS", (t) => {
    const result = run(t, ["--profile", "fixture", "--regions", "us-east-1"]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^status: ok$/m);
    assert.match(result.stdout, /^calls: 2 \(0 failed\)$/m);
    assert.match(result.stdout, /calls by kind: account 1, system listing 1, tag listing 0, profile read 0/);
    assert.match(result.stdout, /^profiles: 1$/m);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("fixture-secret-key"), "no key is printed");
});

test("--tag runs the tagged discovery", (t) => {
    const result = run(t, ["--profile", "fixture", "--tag", "fixture-team"]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /calls by kind: account 1, system listing 0, tag listing 1, profile read 1/);
});

test("a refused listing is named in the output and fails the run", (t) => {
    const result = run(t, ["--profile", "fixture"], "list");
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^call 2 failed after \d+ms \(system listing\)/m);
    assert.match(result.stdout, /^status: permission_denied$/m);
    assert.match(result.stdout, /^calls: 2 \(1 failed\)$/m);
});

test("a refused account check fails the run before any listing", (t) => {
    const result = run(t, ["--profile", "fixture"], "sts");
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /\(account\)/);
    assert.match(result.stdout, /^calls: 1 \(1 failed\)$/m);
});
