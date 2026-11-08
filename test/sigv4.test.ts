// SigV4 itself: AWS's published example, so the algorithm is checked against something other than our own request, then the
// two details this provider relies on — the session token is signed, and the body is part of the signature.
import assert from "node:assert/strict";
import test from "node:test";
import { signRequest } from "../src/sigv4.ts";

const CREDENTIALS = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

test("signs AWS's published example request exactly", () => {
    const headers = signRequest({
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
        region: "us-east-1",
        service: "iam",
        credentials: CREDENTIALS,
        now: new Date("2015-08-30T12:36:00Z"),
    });
    assert.equal(headers["x-amz-date"], "20150830T123600Z");
    assert.equal(
        headers.authorization,
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
            "SignedHeaders=content-type;host;x-amz-date, " +
            "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
});

test("signs the session token as a header, and includes the body in the signature", () => {
    const base = {
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages",
        headers: { "content-type": "application/json" },
        region: "us-east-1",
        now: new Date("2026-11-06T09:00:00Z"),
        credentials: { ...CREDENTIALS, sessionToken: "session-token" },
    } as const;
    const empty = signRequest({ ...base, body: "" });
    assert.equal(empty["x-amz-security-token"], "session-token");
    assert.match(empty.authorization ?? "", /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/);

    const body = signRequest({ ...base, body: '{"model":"arn"}' });
    assert.notEqual(body.authorization, empty.authorization, "a different body is a different signature");
});
