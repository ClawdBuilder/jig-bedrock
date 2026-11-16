import assert from "node:assert/strict";
import test from "node:test";
import { category, discoveryHelp } from "../src/aws-discovery.ts";

test("invalid keys and a disabled region are a credentials problem, not a permission or SSO expiry", () => {
    for (const message of [
        "An error occurred (UnrecognizedClientException): The security token included in the request is invalid.",
        "InvalidClientTokenId: The security token included in the request is invalid.",
        "The security token included in the request is invalid.",
    ])
        assert.equal(category(message), "invalid_credentials", message);
    assert.doesNotMatch(discoveryHelp("invalid_credentials"), /ListInferenceProfiles|administrator/);
    assert.match(discoveryHelp("invalid_credentials"), /revoked or wrong/);
    assert.match(discoveryHelp("invalid_credentials"), /region may not be enabled/);
});

test("real SSO expiry messages still map to sso_expired", () => {
    for (const message of [
        "Error loading SSO Token: Token for my-profile has expired",
        "SSO session has expired; run aws sso login",
        "aws sso login required",
    ])
        assert.equal(category(message), "sso_expired", message);
});
