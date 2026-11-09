// The publish workflow authenticates with npm Trusted Publishing: GitHub's OIDC token is exchanged for a short-lived
// publish credential, so no npm token is stored in the repository or the job. A token secret creeping back in would
// still publish, but through token auth instead of the trusted path, so its absence is tested.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "publish.yml"), "utf8");

test("publishing uses Trusted Publishing, with no stored npm token", () => {
    assert.doesNotMatch(workflow, /NPM_TOKEN/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test("the job has the OIDC permission, the registry and provenance", () => {
    assert.match(workflow, /^\s+id-token: write$/m);
    assert.match(workflow, /^\s+registry-url: https:\/\/registry\.npmjs\.org$/m);
    assert.match(workflow, /npm publish --provenance --access public/);
});

test("npm is checked against 11.5.1 and the job fails with a clear message below it", () => {
    assert.match(workflow, /npm --version/);
    assert.match(workflow, /11\.5\.1/);
    assert.match(workflow, /cannot publish with Trusted Publishing/);
});

test("a tag still publishes only the version in package.json after ci-ok", () => {
    assert.match(workflow, /The tag and package\.json agree/);
    assert.match(workflow, /version="\$\{TAG#v\}"/);
    assert.match(workflow, /Require ci-ok on the tagged commit/);
    assert.match(workflow, /select\(\.name == "ci-ok"\)/);
});
