import assert from "node:assert/strict";
import test from "node:test";
import { getCallerIdentity, getInferenceProfile, getResources, listInferenceProfiles } from "../src/aws-api.ts";
import { category } from "../src/aws-discovery.ts";

const credentials = { accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret", sessionToken: "token" };

function recorder(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response();
    };
    return { calls, fetch: fetch as typeof globalThis.fetch };
}

test("STS GetCallerIdentity signs a query request and reads Account from XML", async () => {
    const r = recorder(
        () =>
            new Response(
                "<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>",
            ),
    );
    const result = await getCallerIdentity("us-east-1", { credentials, fetch: r.fetch });
    assert.deepEqual(result, { Account: "123456789012" });
    const [call] = r.calls;
    assert.equal(call?.url, "https://sts.us-east-1.amazonaws.com/");
    assert.equal(call?.init.method, "POST");
    assert.match(String(call?.init.body), /Action=GetCallerIdentity/);
    const headers = call?.init.headers as Record<string, string>;
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.ok(headers["x-amz-date"]);
    assert.equal(headers["x-amz-security-token"], "token");
    assert.match(headers.authorization, /SignedHeaders=.*host/);
});

test("GetResources signs the tagging target and carries tag filters and pagination", async () => {
    const r = recorder(
        () =>
            new Response(
                JSON.stringify({
                    ResourceTagMappingList: [{ ResourceARN: "arn:one", Tags: [{ Key: "Team", Value: "x" }] }],
                    PaginationToken: "next",
                }),
            ),
    );
    const result = await getResources(
        "eu-west-1",
        { tagFilters: [{ Key: "Team", Values: ["x"] }], paginationToken: "page" },
        { credentials, fetch: r.fetch },
    );
    assert.equal(result.PaginationToken, "next");
    const [call] = r.calls;
    assert.equal(call?.url, "https://tagging.eu-west-1.amazonaws.com/");
    const headers = call?.init.headers as Record<string, string>;
    assert.equal(headers["x-amz-target"], "ResourceGroupsTaggingAPI_20170126.GetResources");
    assert.match(String(call?.init.body), /"PaginationToken":"page"/);
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 /);
});

test("ListInferenceProfiles signs a REST GET and paginates with nextToken", async () => {
    const r = recorder(() => new Response(JSON.stringify({ inferenceProfileSummaries: [], nextToken: "next" })));
    await listInferenceProfiles("us-east-1", { nextToken: "page" }, { credentials, fetch: r.fetch });
    const [call] = r.calls;
    assert.equal(
        call?.url,
        "https://bedrock.us-east-1.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&nextToken=page",
    );
    assert.ok(call);
    assert.equal(call.init.method, "GET");
    assert.match((call.init.headers as Record<string, string>).authorization, /^AWS4-HMAC-SHA256 /);
});

test("GetInferenceProfile URL-encodes the id", async () => {
    const r = recorder(() => new Response(JSON.stringify({ inferenceProfileArn: "arn:one" })));
    await getInferenceProfile("us-east-1", "team/a b", { credentials, fetch: r.fetch });
    assert.equal(r.calls[0]?.url, "https://bedrock.us-east-1.amazonaws.com/inference-profiles/team%2Fa%20b");
});

test("AWS error kinds are classified by category()", async () => {
    const cases: Array<[number, string, string]> = [
        [
            403,
            JSON.stringify({
                __type: "AccessDeniedException",
                message: "not authorized to perform: bedrock:ListInferenceProfiles",
            }),
            "permission_denied",
        ],
        [
            403,
            JSON.stringify({
                __type: "UnrecognizedClientException",
                message: "The security token included in the request is invalid.",
            }),
            "permission_denied",
        ],
        [400, JSON.stringify({ __type: "ThrottlingException", message: "Rate exceeded" }), "unavailable"],
        [500, "oops", "unavailable"],
    ];
    for (const [status, body, expected] of cases) {
        const r = recorder(() => new Response(body, { status }));
        await assert.rejects(
            listInferenceProfiles("us-east-1", {}, { credentials, fetch: r.fetch }),
            (error: unknown) => {
                assert.equal(category(error), expected, `${status} ${body} -> ${String(error)}`);
                return true;
            },
        );
    }
});

test("network and timeout failures are classified", async () => {
    await assert.rejects(
        listInferenceProfiles(
            "us-east-1",
            {},
            {
                credentials,
                fetch: async () => {
                    throw new Error("fetch failed: getaddrinfo ENOTFOUND");
                },
            },
        ),
        (error: unknown) => category(error) === "network",
    );
    await assert.rejects(
        listInferenceProfiles(
            "us-east-1",
            {},
            {
                credentials,
                fetch: async () => {
                    throw new Error("This operation was aborted");
                },
            },
        ),
        (error: unknown) => category(error) === "timeout",
    );
});
