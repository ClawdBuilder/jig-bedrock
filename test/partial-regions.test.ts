import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery } from "../src/aws-discovery.ts";
import { createTestDiscovery } from "./support/discovery-api.ts";

const account = "123456789012";
const arn = (region: string) =>
    `arn:aws:bedrock:${region}:${account}:inference-profile/global.anthropic.claude-sonnet-5-5`;
const profile = (region: string) => ({
    inferenceProfileArn: arn(region),
    inferenceProfileName: "Sonnet",
    status: "ACTIVE",
    models: [{ modelArn: `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-5-5` }],
});

function run(region: string, status = "ok"): Promise<string> {
    if (status === "denied")
        return Promise.reject(
            new Error(
                "An error occurred (UnrecognizedClientException): The security token included in the request is invalid.",
            ),
        );
    if (status === "timeout") return Promise.reject(new Error("timeout"));
    return Promise.resolve(JSON.stringify({ inferenceProfileSummaries: [profile(region)] }));
}

test("one failed region keeps the other region's models and warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-partial-"));
    try {
        const config = { mode: "system" as const, regions: ["us-east-1", "eu-central-2"], profile: "fixture" };
        const source = createTestDiscovery(
            config as never,
            async (_program, args) =>
                args.includes("get-caller-identity")
                    ? JSON.stringify({ Account: account })
                    : run(
                          args[args.indexOf("--region") + 1] ?? "us-east-1",
                          args.includes("eu-central-2") ? "denied" : "ok",
                      ),
            join(dir, "catalog.json"),
            () => Date.now(),
            { HOME: dir } as never,
        );
        assert.equal(await source.refresh(true), "ok");
        const catalog = source.load();
        assert.equal(catalog?.profiles.length, 1);
        assert.match(catalog?.warnings?.join("\n") ?? "", /eu-central-2 did not answer: the security token is invalid/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a timeout in one region keeps the other region's models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-partial-"));
    try {
        const config = { mode: "system" as const, regions: ["us-east-1", "eu-central-2"], profile: "fixture" };
        const source = createTestDiscovery(
            config as never,
            async (_program, args) =>
                args.includes("get-caller-identity")
                    ? JSON.stringify({ Account: account })
                    : run(
                          args[args.indexOf("--region") + 1] ?? "us-east-1",
                          args.includes("eu-central-2") ? "timeout" : "ok",
                      ),
            join(dir, "catalog.json"),
            () => Date.now(),
            { HOME: dir } as never,
        );
        assert.equal(await source.refresh(true), "ok");
        assert.equal(source.load()?.profiles.length, 1);
        assert.match(source.load()?.warnings?.join("\n") ?? "", /eu-central-2 did not answer: AWS timed out/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("when every region fails the refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-partial-"));
    try {
        const config = { mode: "system" as const, regions: ["us-east-1", "eu-central-2"], profile: "fixture" };
        const source = createTestDiscovery(
            config as never,
            async (_program, args) =>
                args.includes("get-caller-identity")
                    ? JSON.stringify({ Account: account })
                    : run(args[args.indexOf("--region") + 1] ?? "us-east-1", "denied"),
            join(dir, "catalog.json"),
            () => Date.now(),
            { HOME: dir } as never,
        );
        assert.notEqual(await source.refresh(true), "ok");
        assert.equal(source.load(), undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
