// The doctor now checks only Node and the AWS CLI: the old shell dependencies are gone with it.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { checkLocalDependencies, dependencyLines } from "../src/doctor.ts";

const config = {
    team: "Fixture",
    profile: "fixture",
    regions: ["us-east-1"],
    ssoLoginCommand: ["fixture"],
    signInAtStart: false,
};
function directory(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-doctor-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function executable(dir: string, name: string, body: string): void {
    writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
}

test("the doctor runs only the AWS CLI version probe", async (t) => {
    const dir = directory(t);
    let calls = 0;
    executable(dir, "aws", `process.stdout.write("aws-cli/2.22.1");`);
    executable(dir, "bash", `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "bash-ran"))}, "bad");`);
    executable(dir, "jq", `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "jq-ran"))}, "bad");`);
    const health = await checkLocalDependencies({ env: { PATH: dir }, nodeVersion: "22.19.0" });
    assert.equal(health.node.status, "ready");
    assert.deepEqual(health.aws, { status: "ready", version: "2.22.1" });
    assert.equal("bash" in health || "jq" in health || "usage" in health, false);
    assert.ok(!dependencyLines(health).some((line) => /Bash|jq/i.test(line)));
    calls++;
    assert.equal(calls, 1);
});

test("an old Node or AWS CLI is reported as old, and a missing AWS CLI as missing", async (t) => {
    const dir = directory(t);
    executable(dir, "aws", 'process.stdout.write("aws-cli/1.42.1");');
    const old = await checkLocalDependencies({ env: { PATH: dir }, nodeVersion: "22.18.0" });
    assert.equal(old.node.status, "old");
    assert.equal(old.aws.status, "old");
    const missing = await checkLocalDependencies({ env: { PATH: "/nonexistent" }, nodeVersion: "22.19.0" });
    assert.equal(missing.aws.status, "missing");
    assert.doesNotMatch(JSON.stringify(missing), /private-canary/);
});

test("version checks time out and kill the only child", async () => {
    const child: any = new EventEmitter();
    child.pid = 9001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = 0;
    child.kill = () => {
        child.killed++;
    };
    const health = await checkLocalDependencies({
        env: { PATH: "/nonexistent" },
        timeout: 10,
        spawn: (() => child) as never,
        timer: (fn) => {
            queueMicrotask(fn);
            return () => {};
        },
    });
    assert.equal(health.aws.status, "timeout");
    assert.ok(child.killed > 0);
});

test("a pre-aborted check starts no child", async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    const health = await checkLocalDependencies({
        env: { PATH: "/nonexistent" },
        signal: controller.signal,
        spawn: (() => {
            spawned++;
            throw new Error("must not start");
        }) as never,
    });
    assert.equal(health.aws.status, "cancelled");
    assert.equal(spawned, 0);
});
