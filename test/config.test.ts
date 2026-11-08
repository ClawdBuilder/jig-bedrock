// The settings of the `bedrock` section that this package added to the ones it moved: what each accepts, what it defaults to, what
// a mistake says (the key, never the value), and that the JIG_BEDROCK_* variables still win over the file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULTS, loadConfig, validateBedrock } from "../src/config.ts";

const MESSAGE =
    "bedrock.browser must be the full path of a program that opens an address, or the name of one on the PATH (no spaces or arguments)";

describe("bedrock.signInAtStart", () => {
    test("is on unless the file turns it off", () => {
        assert.equal(DEFAULTS.signInAtStart, true);
        assert.equal(loadConfig({ raw: { team: "t" }, env: {} }).config?.signInAtStart, true);
        assert.equal(loadConfig({ raw: { team: "t", signInAtStart: false }, env: {} }).config?.signInAtStart, false);
        assert.equal(loadConfig({ raw: { team: "t", signInAtStart: true }, env: {} }).config?.signInAtStart, true);
    });

    test("is true or false, and a mistake names the key and not the value", () => {
        assert.deepEqual(validateBedrock({ team: "t", signInAtStart: false }), []);
        for (const value of ["private-canary", 1, null, []]) {
            const messages = validateBedrock({ team: "t", signInAtStart: value });
            assert.deepEqual(messages, ["bedrock.signInAtStart must be true or false"]);
            assert.equal(loadConfig({ raw: { team: "t", signInAtStart: value }, env: {} }).config, undefined);
        }
    });
});

describe("bedrock.browser", () => {
    test("is a full path or the name of a program on the PATH, and nothing else", () => {
        for (const value of ["/usr/bin/wslview", "/opt/my-tools/open", "wslview", "xdg-open", "google-chrome-stable"]) {
            assert.deepEqual(validateBedrock({ team: "t", browser: value }), [], value);
        }
        for (const value of [
            "",
            " ",
            "/opt/my tools/open",
            "./open",
            "../bin/open",
            "bin/open",
            "wslview --new-tab",
            "firefox %s",
            "/usr/bin/open\nx",
            "~/open",
            7,
            true,
            ["/usr/bin/open"],
            null,
        ]) {
            assert.deepEqual(validateBedrock({ team: "t", browser: value }), [MESSAGE], JSON.stringify(value));
        }
    });

    test("is not there unless the file gives it, and a mistake does not repeat the value", () => {
        assert.equal(loadConfig({ raw: { team: "t" }, env: {} }).config?.browser, undefined);
        assert.equal(
            loadConfig({ raw: { team: "t", browser: "/usr/bin/wslview" }, env: {} }).config?.browser,
            "/usr/bin/wslview",
        );
        const refused = loadConfig({ raw: { team: "t", browser: "private-canary --flag" }, env: {} });
        assert.equal(refused.config, undefined);
        assert.match(refused.error ?? "", /^bedrock\.browser must be/);
        assert.doesNotMatch(refused.error ?? "", /canary/);
    });
});

describe("the section's messages", () => {
    test("name keys of the bedrock section, none of the old jig.bedrock", () => {
        const messages = validateBedrock({ profile: "bad profile", regions: [], monthlyBudgetUsd: 0, typo: 1 });
        assert.ok(messages.length >= 5, messages.join("\n"));
        for (const message of messages) {
            assert.match(message, /^bedrock\./);
            assert.doesNotMatch(message, /jig\.bedrock/);
        }
        assert.deepEqual(validateBedrock("private-canary"), ["bedrock must be an object"]);
        assert.deepEqual(validateBedrock([]), ["bedrock must be an object"]);
    });

    test("a missing team says to set bedrock.team, and a wrong field in the file says where to look", () => {
        assert.match(loadConfig({ raw: undefined, env: {} }).error ?? "", /^Set bedrock\.team in the bedrock settings/);
        assert.match(
            loadConfig({ raw: { team: "t", typo: 1 }, env: {} }).error ?? "",
            /^Unknown field in bedrock in jig\.json/,
        );
    });
});

describe("the environment", () => {
    test("JIG_BEDROCK_TEAM, _PROFILE, _REGIONS and _PAT_DIR still win over the file, and give a team the file lacks", () => {
        const env = {
            JIG_BEDROCK_TEAM: "From The Environment",
            JIG_BEDROCK_PROFILE: "env-profile",
            JIG_BEDROCK_REGIONS: "us-west-2, eu-west-1",
            JIG_BEDROCK_USAGE_DIR: "/env/usage",
        };
        const raw = { team: "From The File", profile: "file-profile", regions: ["us-east-1"], usageDir: "/file/usage" };
        const config = loadConfig({ raw, env }).config;
        assert.equal(config?.team, "From The Environment");
        assert.equal(config?.profile, "env-profile");
        assert.deepEqual(config?.regions, ["eu-west-1", "us-west-2"]);
        assert.equal(config?.usageDir, "/env/usage");
        assert.equal(loadConfig({ raw: undefined, env }).config?.team, "From The Environment");
    });
});

describe("bedrock.api", () => {
    test("is messages unless the file chooses converse, and a mistake names the key", () => {
        assert.equal(DEFAULTS.api, "messages");
        assert.equal(loadConfig({ raw: { team: "t" }, env: {} }).config?.api, "messages");
        assert.equal(loadConfig({ raw: { team: "t", api: "converse" }, env: {} }).config?.api, "converse");
        assert.deepEqual(validateBedrock({ team: "t", api: "messages" }), []);
        assert.deepEqual(validateBedrock({ team: "t", api: "converse" }), []);
        for (const value of ["chat", "", 1, null]) {
            assert.deepEqual(validateBedrock({ team: "t", api: value }), [
                'bedrock.api must be "messages" (the Anthropic Messages route) or "converse" (the older route)',
            ]);
            assert.equal(loadConfig({ raw: { team: "t", api: value }, env: {} }).config, undefined);
        }
    });
});

test("program settings come from bedrock.json or the environment, never the project section", async () => {
    const { settingsFrom, agentFolder } = await import("../src/provider.ts");
    const dir = mkdtempSync(join(tmpdir(), "bedrock-guard-"));
    try {
        writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ bedrock: { usageDir: "/user/usage" } }));
        const api = {
            config: {
                registerSection() {},
                section: (name: string) =>
                    name === "bedrock"
                        ? {
                              team: "t",
                              usageDir: "/project/usage",
                              ssoLoginCommand: ["sh", "-c", "evil"],
                              browser: "/project/browser",
                          }
                        : undefined,
            },
        } as never;
        const env = { PI_CODING_AGENT_DIR: dir };
        assert.equal(agentFolder(env), dir);
        assert.deepEqual(settingsFrom(api, env), { team: "t", usageDir: "/user/usage" });
        assert.equal(settingsFrom(undefined, { ...env, JIG_BEDROCK_USAGE_DIR: "/env" })?.usageDir, "/user/usage");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
