import assert from "node:assert/strict";
import test from "node:test";
import { category } from "../src/aws-discovery.ts";

test("a disabled region's invalid token is a permission problem, not SSO expiry", () => {
    assert.equal(
        category(
            "An error occurred (UnrecognizedClientException): The security token included in the request is invalid.",
        ),
        "permission_denied",
    );
    assert.equal(category("The security token included in the request is invalid."), "permission_denied");
});

test("real SSO expiry messages still map to sso_expired", () => {
    for (const message of [
        "Error loading SSO Token: Token for my-profile has expired",
        "SSO session has expired; run aws sso login",
        "aws sso login required",
    ])
        assert.equal(category(message), "sso_expired", message);
});
