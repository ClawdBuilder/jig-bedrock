// Repository process: the pull-request and issue surfaces, dependency pinning, scheduled CI, and the source map.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

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
    assert.match(ci, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
    assert.match(ci, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
    assert.match(ci, /scripts\/scheduled-issue\.sh/);
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

test("the scheduled-issue script creates or comments exactly once", async (t) => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "scheduled-issue-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "gh.log");
    const fake = join(dir, "gh");
    writeFileSync(
        fake,
        `#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "issue list" ]; then
  [ "$#" -eq 10 ] || exit 1
  case "$FAKE_LIST" in
    "[]") ;;
    *'"title":"Scheduled CI failed"'*) echo 7 ;;
    *) ;;
  esac
fi
exit 0
`,
        { mode: 0o755 },
    );
    const run = (list: string) =>
        spawnSync("bash", ["scripts/scheduled-issue.sh"], {
            cwd: join(import.meta.dirname, ".."),
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH}`,
                GH_TOKEN: "x",
                GH_LOG: log,
                FAKE_LIST: list,
                RUN_URL: "https://example.test/run",
            },
            encoding: "utf8",
        });
    const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);

    assert.equal(run("[]").status, 0);
    assert.equal(lines().filter((line) => line.startsWith("issue create")).length, 1);
    writeFileSync(log, "");
    assert.equal(run('[{"number":7,"title":"Scheduled CI failed"}]').status, 0);
    assert.deepEqual(
        lines().filter((line) => line.startsWith("issue comment")),
        ["issue comment 7 --body The scheduled run failed: https://example.test/run. Fix it before the next release."],
    );
    writeFileSync(log, "");
    assert.equal(run('[{"number":8,"title":"Other"}]').status, 0);
    assert.equal(lines().filter((line) => line.startsWith("issue create")).length, 1);

    const old = spawnSync(
        "bash",
        [
            "-c",
            `title="Scheduled CI failed"; gh issue list --state open --search "\${title} in:title" --json number,title --jq ".[] | select(.title == "\${title}") | .number"`,
        ],
        {
            cwd: join(import.meta.dirname, ".."),
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, FAKE_LIST: "[]" },
            encoding: "utf8",
        },
    );
    assert.notEqual(old.status, 0, "the old quoting should fail against the fake gh");
});

test("every job that runs actionlint checks out the repository first", () => {
    const ci = parse(read(".github/workflows/ci.yml")) as {
        jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> }>;
    };
    let checked = 0;
    for (const [name, job] of Object.entries(ci.jobs)) {
        const steps = job.steps ?? [];
        const actionlint = steps.findIndex((step) => typeof step.run === "string" && /actionlint/.test(step.run));
        if (actionlint === -1) continue;
        checked++;
        const checkout = steps.findIndex(
            (step, index) =>
                index < actionlint &&
                step.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" &&
                step.with?.["persist-credentials"] === false,
        );
        assert.notEqual(checkout, -1, `${name} runs actionlint without a pinned checkout before it`);
    }
    assert.ok(checked > 0, "no actionlint job found");
});
