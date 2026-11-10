// bedrock.json is the only file the /login flow writes: discovery choices and regions, never a profile or a secret, and
// every other key in the file is preserved.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveDiscoverySettings } from "../src/settings-write.ts";

function folder(): { dir: string; env: NodeJS.ProcessEnv; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-"));
    return { dir, env: { HOME: dir, PI_CODING_AGENT_DIR: dir }, file: join(dir, "bedrock.json") };
}

function read(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("system discovery replaces the mode keys and keeps unrelated settings", () => {
    const { dir, env, file } = folder();
    try {
        writeFileSync(
            file,
            JSON.stringify({
                usageDir: "/opt/usage",
                profile: "keep-me",
                team: "Old",
                tagKey: "Team",
                tagValue: "old",
            }),
        );
        const result = saveDiscoverySettings(env, { mode: "system", regions: ["us-east-1"] });
        assert.equal(result.written, true);
        const saved = read(file);
        assert.deepEqual(saved.regions, ["us-east-1"]);
        assert.equal(saved.usageDir, "/opt/usage");
        assert.equal(saved.profile, "keep-me", "the profile is the credential's business, never written here");
        for (const key of ["team", "tagKey", "tagValue", "activeTagKey", "activeTagValue", "profiles"])
            assert.equal(key in saved, false, key);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("tag discovery writes the key and value and drops the other modes", () => {
    const { dir, env, file } = folder();
    try {
        writeFileSync(file, JSON.stringify({ profiles: ["old"], team: "Old" }));
        assert.equal(
            saveDiscoverySettings(env, {
                mode: "tag",
                regions: ["us-east-1"],
                tagKey: "Team",
                tagValue: "my-team",
            }).written,
            true,
        );
        const saved = read(file);
        assert.equal(saved.tagKey, "Team");
        assert.equal(saved.tagValue, "my-team");
        assert.equal("profiles" in saved, false);
        assert.equal("team" in saved, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("explicit discovery writes the list and drops tag settings", () => {
    const { dir, env, file } = folder();
    try {
        writeFileSync(file, JSON.stringify({ tagKey: "Team", tagValue: "old" }));
        saveDiscoverySettings(env, {
            mode: "explicit",
            regions: ["eu-west-1"],
            profiles: ["arn:aws:bedrock:us-east-1:123456789012:inference-profile/a"],
        });
        const saved = read(file);
        assert.deepEqual(saved.profiles, ["arn:aws:bedrock:us-east-1:123456789012:inference-profile/a"]);
        assert.equal("tagKey" in saved, false);
        assert.equal("tagValue" in saved, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a nested bedrock object stays nested and its siblings stay", () => {
    const { dir, env, file } = folder();
    try {
        writeFileSync(file, JSON.stringify({ bedrock: { usageDir: "/opt/usage" }, somethingElse: 1 }));
        saveDiscoverySettings(env, { mode: "system", regions: ["us-east-1"] });
        const saved = read(file) as { bedrock: Record<string, unknown>; somethingElse: number };
        assert.equal(saved.somethingElse, 1);
        assert.equal(saved.bedrock.usageDir, "/opt/usage");
        assert.deepEqual(saved.bedrock.regions, ["us-east-1"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("unreadable JSON is reported and not overwritten", () => {
    const { dir, env, file } = folder();
    try {
        writeFileSync(file, "{ not json");
        const result = saveDiscoverySettings(env, { mode: "system", regions: ["us-east-1"] });
        assert.equal(result.written, false);
        assert.match(result.error ?? "", /could not be read as JSON/);
        assert.equal(readFileSync(file, "utf8"), "{ not json");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
