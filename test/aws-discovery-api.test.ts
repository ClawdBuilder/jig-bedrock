import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery } from "../src/aws-discovery.ts";

const account = "123456789012";
const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/one";

test("discovery resolves credentials once and makes no child process call", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-api-discovery-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let credentials = 0;
    const runner = 0;
    let resources = 0;
    const api = {
        getCallerIdentity: async () => ({ Account: account }),
        getResources: async () => {
            resources++;
            return {
                ResourceTagMappingList: [
                    {
                        ResourceARN: arn,
                        Tags: [
                            { Key: "Team", Value: "fixture" },
                            { Key: "Active", Value: "true" },
                        ],
                    },
                ],
            };
        },
        listInferenceProfiles: async () => ({ inferenceProfileSummaries: [] }),
        getInferenceProfile: async () => ({
            inferenceProfileArn: arn,
            inferenceProfileName: "One",
            status: "ACTIVE",
            models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5" }],
        }),
    };
    const source = createAwsDiscovery(
        {
            mode: "tag",
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            tagKey: "Team",
            tagValue: "fixture",
            activeTagKey: "Active",
            activeTagValue: "true",
        } as never,
        join(dir, "catalog.json"),
        () => Date.now(),
        {},
        {
            api: api as never,
            useApi: true,
            credentials: async () => {
                credentials++;
                return { accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" };
            },
        },
    );
    assert.equal(await source.refresh(true), "ok");
    assert.equal(credentials, 1);
    assert.equal(runner, 0);
    assert.equal(resources, 1);
    assert.equal(source.load()?.profiles.length, 1);
    await source.refresh(true);
    assert.equal(credentials, 2, "one resolution per discovery run");
    assert.equal(runner, 0);
});
