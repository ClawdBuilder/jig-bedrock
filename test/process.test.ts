// Repository process: the pull-request and issue surfaces, dependency pinning, scheduled CI, and the source map.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

test("the PR template asks for Summary, Evidence and Merge Danger", () => {
    const text = read(".github/pull_request_template.md");
    for (const heading of ["## Summary", "## Evidence", "## Merge Danger"]) assert.ok(text.includes(heading), heading);
});

test("the issue forms ask for doctor output, versions, install method and a redaction reminder", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug.yml");
    for (const phrase of [
        "/bedrock doctor output",
        "Pi version",
        "Node version",
        "How jig-bedrock was installed",
        "account ids, ARNs and AWS profile names",
    ])
        assert.ok(bug.includes(phrase), phrase);
    assert.ok(read(".github/ISSUE_TEMPLATE/feature.yml").includes("name: Feature"));
    assert.ok(read(".github/ISSUE_TEMPLATE/config.yml").includes("blank_issues_enabled: false"));
});

test("dependency pins are exact and .npmrc keeps them exact with a release age", () => {
    const pkg = JSON.parse(read("package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: { test?: string };
    };
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
        assert.match(version, /^\d/, `${name} is not exact`);
    const npmrc = read(".npmrc");
    assert.match(npmrc, /^save-exact=true$/m);
    assert.match(npmrc, /^min-release-age=\d+$/m);
    assert.match(pkg.scripts?.test ?? "", /--test-timeout=\d+/);
});

test("CI runs weekly, reports one scheduled issue, and actionlint is pinned in ci-ok", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /cron: "17 3 \* \* 1"/);
    assert.match(ci, /scheduled-issue:/);
    assert.match(ci, /issues: write/);
    assert.match(ci, /actionlint/);
    assert.match(ci, /download-actionlint\.bash \| bash -s -- 1\.7\.7/);
    assert.match(ci, /needs: \[checks, pi-versions, packed-install, macos\]/);
});

test("every src file is in the contributing table, and the table names no ghost", () => {
    const page = read("docs/contributing.md");
    const table = page.slice(page.indexOf("## Where the code goes"), page.indexOf("## How CI works"));
    const named = new Set([...table.matchAll(/`src\/([^`]+)\.ts`/g)].map((match) => match[1]));
    const actual = new Set(
        readdirSync(join(root, "src"))
            .filter((name) => name.endsWith(".ts"))
            .map((name) => name.slice(0, -3)),
    );
    assert.deepEqual([...actual].sort(), [...named].sort());
});

test("the root CONTRIBUTING points at the detailed page and AGENTS.md", () => {
    const text = read("CONTRIBUTING.md");
    assert.match(text, /docs\/contributing\.md/);
    assert.match(text, /AGENTS\.md/);
});
