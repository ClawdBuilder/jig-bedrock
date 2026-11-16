import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import { getCallerIdentity, getInferenceProfile, getResources, listInferenceProfiles } from "../src/aws-api.ts";
import { category } from "../src/aws-discovery.ts";
import { signRequest } from "../src/sigv4.ts";

const credentials = { accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret", sessionToken: "token" };

function recorder(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
        new Request(url, init);
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

test("AWS error kinds are classified from their code and HTTP status", async () => {
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
            "invalid_credentials",
        ],
        [400, JSON.stringify({ __type: "ThrottlingException", message: "Rate exceeded" }), "throttled"],
        [400, JSON.stringify({ __type: "TooManyRequestsException", message: "Too many requests" }), "throttled"],
        [429, "", "throttled"],
        [500, "oops", "aws_error"],
        [503, JSON.stringify({ __type: "ServiceUnavailableException", message: "Try again." }), "aws_error"],
        [
            403,
            JSON.stringify({
                __type: "ExpiredTokenException",
                message: "The security token included in the request is expired",
            }),
            "expired_credentials",
        ],
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

test("STS XML errors keep the AWS code and message for the advice", async () => {
    for (const [code, message, expected] of [
        ["InvalidClientTokenId", "The security token included in the request is invalid.", "invalid_credentials"],
        ["ExpiredToken", "The security token included in the request is expired", "expired_credentials"],
    ] as const) {
        const r = recorder(
            () =>
                new Response(
                    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
                    { status: 403 },
                ),
        );
        await assert.rejects(getCallerIdentity("us-east-1", { credentials, fetch: r.fetch }), (error: unknown) => {
            assert.equal(category(error), expected);
            assert.ok(String(error).includes(`${code}: ${message}`), String(error));
            return true;
        });
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
                    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
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

test("the canonical URI double-encodes an ARN segment", async () => {
    const { canonicalUri } = await import("../src/sigv4.ts");
    const identifier = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123example";
    const url = new URL(`https://bedrock.us-east-1.amazonaws.com/inference-profiles/${encodeURIComponent(identifier)}`);
    assert.equal(
        canonicalUri(url),
        "/inference-profiles/arn%253Aaws%253Abedrock%253Aus-east-1%253A123456789012%253Aapplication-inference-profile%252Fabc123example",
    );
});

test("a request-building TypeError is not reported as a network failure", async () => {
    await assert.rejects(
        listInferenceProfiles(
            "us-east-1",
            {},
            {
                credentials,
                fetch: async () => {
                    throw new TypeError("Request with GET/HEAD method cannot have body.");
                },
            },
        ),
        (error: unknown) => {
            assert.match((error as Error).message, /GET\/HEAD method cannot have body/);
            assert.doesNotMatch((error as Error).message, /AWS could not be reached/);
            assert.equal(category(error), "unavailable");
            return true;
        },
    );
});
