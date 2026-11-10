// The signed fetch: it removes the Anthropic client's own auth, adds a SigV4 authorization, signs the session token, and turns
// a credential failure into the one message Pi's SSO recovery recognizes. No request leaves this file.
import assert from "node:assert/strict";
import test from "node:test";
import { createSignedFetch, regionOf } from "../src/bedrock-fetch.ts";

const URL = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages";
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session-token" };

test("reads the region from a Bedrock runtime host, and refuses another host", () => {
    assert.equal(regionOf(URL), "us-east-1");
    assert.equal(regionOf("https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic/v1/messages"), "eu-west-1");
    assert.equal(
        regionOf("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/anthropic/v1/messages"),
        "us-gov-west-1",
    );
    assert.equal(regionOf("https://api.anthropic.com/v1/messages"), undefined);
});

test("signs the request and removes the client's key and authorization headers", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetch = createSignedFetch({
        credentials: async () => CREDENTIALS,
        now: () => new Date("2026-11-06T09:00:00Z"),
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
            sent = { url: String(url), init: init ?? {} };
            return new Response("{}", { status: 200 });
        }) as typeof globalThis.fetch,
    });
    const response = await fetch(URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": "bedrock-sigv4",
            authorization: "Bearer never",
        },
        body: '{"model":"arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p0"}',
    });
    assert.equal(response.status, 200);
    assert.equal(sent?.url, URL);
    const headers = new Headers(sent?.init.headers);
    assert.equal(headers.get("x-api-key"), null, "the client's key never reaches the wire");
    assert.equal(headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "), true);
    assert.match(headers.get("authorization") ?? "", /Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
    assert.equal(headers.get("x-amz-date"), "20261106T090000Z");
    assert.equal(headers.get("x-amz-security-token"), "session-token");
    assert.equal(headers.get("content-type"), "application/json");
});

test("an expired SSO session returns a marked 401 in words Pi's recovery matches", async () => {
    const fetch = createSignedFetch({
        credentials: async () => {
            throw new Error("The SSO session has expired; run aws sso login --profile my-profile.");
        },
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
    });
    const response = await fetch(URL, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-jig-sso-expiry"), "1");
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /SSO session/);
    assert.match(body.error?.message ?? "", /aws sso login/);
    assert.doesNotMatch(JSON.stringify(body), /my-bedrock-profile/);
});
