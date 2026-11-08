// The model ids this provider registers for a team's profiles. jig-jig chooses the model of each agent role as a plain string,
// `jig-bedrock/claude-sonnet-5-5` and `jig-bedrock/claude-opus-5-5`, without importing anything from here. This is the half
// of that agreement that lives in this package: the id of a profile is the slug of Pi's name for its foundation model, under the
// provider id `jig-bedrock`, with no ARN. If it changes, jig-jig's agents defaults must change with it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { discoveredProfiles, usePiRegistry } from "../src/catalog.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { hostImport } from "./support/pi-host.ts";

test("a team's Sonnet 5.5 and Opus 5.5 profiles are models jig-bedrock/claude-sonnet-5-5 and jig-bedrock/claude-opus-5-5", async () => {
    assert.equal(JIG_BEDROCK, "jig-bedrock", "users' settings, enabledModels and agent role models name this provider");
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    usePiRegistry(builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock"));
    const region = "us-east-1";
    const catalog: Catalog = {
        schema: 1,
        team: "fixture",
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: ["anthropic.claude-sonnet-5-5", "anthropic.claude-opus-5-5"].map((model, n) => ({
            arn: `arn:aws:bedrock:${region}:123456789012:application-inference-profile/p${n}`,
            profile_name: `Fixture ${n}`,
            foundation_model_id: model,
            region,
        })),
    };
    const empty = mkdtempSync(path.join(tmpdir(), "jig-bedrock-usage-"));
    try {
        const { available, unavailable } = discoveredProfiles(catalog, empty);
        assert.deepEqual(unavailable, []);
        assert.deepEqual(available.map((model) => `${JIG_BEDROCK}/${model.id}`).sort(), [
            "jig-bedrock/claude-opus-5-5",
            "jig-bedrock/claude-sonnet-5-5",
        ]);
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
});
