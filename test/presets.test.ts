// Presets layer one named set of settings under the environment, over the top-level file.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const raw = {
    profile: "top",
    regions: ["us-east-1"],
    presets: {
        work: { profile: "company", tagKey: "Team", tagValue: "team", monthlyBudgetUsd: 200 },
        personal: { profile: "home", regions: ["us-west-2"] },
    },
    preset: "work",
};

test("an active preset wins over the top-level file, and the environment wins over both", () => {
    const preset = loadConfig({ raw, env: {} });
    assert.equal(preset.config?.profile, "company");
    assert.equal(preset.config?.preset, "work");
    assert.equal(preset.config?.profileSource, "preset");
    assert.equal(preset.config?.monthlyBudgetUsd, 200);
    assert.equal(preset.config?.mode, "tag");
    const env = loadConfig({ raw, env: { JIG_BEDROCK_PRESET: "personal", JIG_BEDROCK_PROFILE: "env" } });
    assert.equal(env.config?.profile, "env");
    assert.equal(env.config?.preset, "personal");
    assert.equal(env.config?.presetSource, "env");
    assert.deepEqual(env.config?.regions, ["us-west-2"]);
});

test("a preset cannot hold a machine-wide setting", () => {
    const result = loadConfig({ raw: { presets: { work: { browser: "x" } } }, env: {} });
    assert.match(result.error ?? "", /work\.browser is machine-wide/);
});

test("an unknown active preset is named, with the known names, and shows no fallback", () => {
    const result = loadConfig({ raw: { ...raw, preset: "missing" }, env: {} });
    assert.equal(result.config?.presetUnknown, "missing");
    assert.deepEqual(result.config?.presetNames, ["personal", "work"]);
    assert.equal(result.config?.profile, undefined);
});

test("preset names are letters, digits and three punctuation marks", () => {
    assert.equal(
        loadConfig({ raw: { presets: { "work-1": { profile: "a" } } }, env: {} }).config?.presetNames?.[0],
        "work-1",
    );
    assert.ok(loadConfig({ raw: { presets: { "bad name": {} } }, env: {} }).error);
});

test("at most eight catalog files are kept, oldest first, and catalog.json is never touched", async () => {
    const { mkdtempSync, writeFileSync, utimesSync, readdirSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pruneCatalogFiles } = await import("../src/aws-discovery.ts");
    const folder = mkdtempSync(join(tmpdir(), "bedrock-catalogs-"));
    try {
        for (let i = 0; i < 10; i++) {
            const file = join(folder, `catalog-${String(i).padStart(12, "0")}.json`);
            writeFileSync(file, "{}");
            utimesSync(file, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
        }
        writeFileSync(join(folder, "catalog.json"), "{}");
        pruneCatalogFiles(folder);
        const left = readdirSync(folder).sort();
        assert.equal(left.filter((name) => /^catalog-[0-9a-f]{12}\.json$/.test(name)).length, 8);
        assert.ok(left.includes("catalog.json"));
        assert.ok(!left.includes("catalog-000000000000.json"));
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
