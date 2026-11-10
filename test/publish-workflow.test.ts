// The publish workflow: a tag publishes to npm with Trusted Publishing, then writes the GitHub release from the
// changelog. The manual dispatch writes an old tag's page and can never publish. Publishing needs the OIDC token; only
// the release job may write the repository, and no npm token exists anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "publish.yml"), "utf8");

/** One job's block: from its key to the next top-level job key. */
function job(name: string): string {
    const start = workflow.search(new RegExp(`^ {4}${name}:$`, "m"));
    assert.ok(start !== -1, `the workflow has a ${name} job`);
    const next = workflow.slice(start + 1).search(/\n {4}[a-z][a-z0-9-]*:/);
    return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
}
const publish = job("publish");
const release = job("release");

test("publishing uses Trusted Publishing, with no stored npm token", () => {
    assert.doesNotMatch(workflow, /NPM_TOKEN/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test("the publish job has the OIDC permission, the registry and provenance", () => {
    assert.match(publish, /id-token: write/);
    assert.match(publish, /registry-url: https:\/\/registry\.npmjs\.org/);
    assert.match(workflow, /npm publish --provenance --access public/);
});

test("publishing happens only for a tag push, so a manual run cannot publish", () => {
    assert.match(publish, /if: github\.event_name == 'push'/);
    assert.doesNotMatch(publish, /workflow_dispatch/);
});

test("the manual run takes the tag to write a page for", () => {
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /inputs:\n +tag:/);
    assert.match(workflow, /required: true/);
});

test("the changelog check runs before anything is published", () => {
    const checked = publish.indexOf("scripts/release-notes.mjs");
    const published = publish.indexOf("npm publish --provenance --access public");
    assert.ok(checked !== -1, "the publish job checks the changelog");
    assert.ok(published !== -1, "the publish job publishes");
    assert.ok(checked < published, "a missing section fails before npm sees the tag");
});

test("a tag still publishes only the version in package.json after ci-ok", () => {
    assert.match(publish, /The tag, package\.json and the changelog agree/);
    assert.match(publish, /version="\$\{TAG#v\}"/);
    assert.match(publish, /Require ci-ok on the tagged commit/);
    assert.match(publish, /select\(\.name == "ci-ok"\)/);
});

test("contents: write is only on the release job", () => {
    assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
    assert.match(release, /contents: write/);
    assert.doesNotMatch(publish, /contents: write/);
    assert.match(workflow, /^permissions:\n {4}contents: read$/m);
});

test("the release runs after the tag's publish, or alone on a manual run", () => {
    assert.match(release, /needs: publish/);
    assert.match(release, /github\.event_name == 'workflow_dispatch' \|\| needs\.publish\.result == 'success'/);
});

test("the release page is that version's changelog section", () => {
    assert.match(release, /workflow\/scripts\/release-notes\.mjs "\$\{TAG#v\}" --root "\$\{NOTES_ROOT\}"/);
    assert.match(release, /--notes-file "\$\{notes\}"/);
    assert.match(release, /--title "\$\{TAG\}"/);
});

test("a second run edits the release instead of failing", () => {
    assert.match(release, /gh release view "\$\{TAG\}"/);
    assert.match(release, /gh release edit "\$\{TAG\}" --title/);
    assert.match(release, /gh release create "\$\{TAG\}" --title/);
});

test("a manual run does not make an old tag Latest", () => {
    assert.match(release, /--latest=false/);
    assert.match(release, /if \[ "\$\{EVENT\}" = "workflow_dispatch" \]/);
});

test("an old tag's page is read from the tag, with the script from the default branch", () => {
    assert.match(release, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(release, /path: workflow/);
});

test("the oldest tags, which have no changelog, use the default branch's copy", () => {
    assert.match(release, /if \[ ! -f CHANGELOG\.md \]/);
    assert.match(release, /its release page uses the default branch's changelog/);
    assert.match(release, /echo "NOTES_ROOT=\$\{root\}" >> "\$\{GITHUB_ENV\}"/);
});

// The CI workflow. `ci-ok` is the one check the publish workflow reads, so a job it does not wait for is a job a release
// can ignore.
const ci = readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
};

/** One job's block of ci.yml: from its key to the next job key. */
function ciJob(name: string): string {
    const start = ci.search(new RegExp(`^ {4}${name}:$`, "m"));
    assert.ok(start !== -1, `ci.yml has a ${name} job`);
    const next = ci.slice(start + 1).search(/\n {4}[a-z][a-z0-9-]*:/);
    return ci.slice(start, next === -1 ? undefined : start + 1 + next);
}

test("ci-ok waits for every other job in ci.yml, whatever it is called", () => {
    const keys = [...ci.matchAll(/^ {4}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1] ?? "");
    const jobs = keys.slice(keys.indexOf("checks")).filter((key) => key !== "ci-ok");
    for (const required of ["checks", "pi-versions", "packed-install", "macos"])
        assert.ok(jobs.includes(required), `ci.yml has the ${required} job`);
    const needs =
        /^ {8}needs: \[([^\]]*)\]$/m
            .exec(ciJob("ci-ok"))?.[1]
            ?.split(",")
            .map((name) => name.trim()) ?? [];
    assert.deepEqual([...needs].sort(), [...jobs].sort(), "ci-ok needs exactly the other jobs");
    assert.match(ciJob("ci-ok"), /if: \$\{\{ always\(\) \}\}/);
    assert.match(ciJob("ci-ok"), /all\(\.value\.result == "success"\)/);
});

test("no CI job is allowed to fail quietly", () => {
    assert.doesNotMatch(ci, /continue-on-error/);
});

test("the Pi version job runs the tests on the oldest supported Pi and the newest one on npm", () => {
    const block = ciJob("pi-versions");
    assert.match(block, /pi: \["1\.5\.0", "latest"\]/);
    assert.match(block, /run: node scripts\/install-pi\.mjs "\$\{\{ matrix\.pi \}\}"/);
    assert.match(block, /run: npm test/);
    // The README names the oldest Pi; the matrix must test that one.
    const readme = readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf8");
    const oldest = /Pi (\d+\.\d+) or later/.exec(readme)?.[1];
    assert.ok(oldest, "the README names the oldest Pi");
    assert.match(block, new RegExp(`pi: \\["${oldest.replace(".", "\\.")}\\.0"`));
});

test("the packed-install job runs the check script on both Pi versions", () => {
    const block = ciJob("packed-install");
    assert.match(block, /pi: \["1\.5\.0", "latest"\]/);
    assert.match(block, /run: node scripts\/install-pi\.mjs "\$\{\{ matrix\.pi \}\}"/);
    assert.match(block, /run: npm run check:packed/);
    assert.equal(manifest.scripts["check:packed"], "node scripts/packed-install-check.mjs");
    assert.equal(manifest.scripts["pi:install"], "node scripts/install-pi.mjs");
});

test("the macOS job runs the type and style checks and the tests", () => {
    const block = ciJob("macos");
    assert.match(block, /runs-on: macos-latest/);
    assert.match(block, /run: npm run check$/m);
    assert.match(block, /run: npm test$/m);
});

test("every action in ci.yml is pinned by commit hash", () => {
    const uses = [...ci.matchAll(/^\s*uses: (\S+)/gm)].map((match) => match[1] ?? "");
    assert.ok(uses.length > 0);
    for (const use of uses) assert.match(use, /^[\w./-]+@[0-9a-f]{40}$/, `${use} is pinned by hash`);
});
