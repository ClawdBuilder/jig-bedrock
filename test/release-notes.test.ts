// scripts/release-notes.mjs: the body a tag's GitHub release carries. A section must exist and have entries, the last
// section runs to the end of the file, and a version never matches a longer version that starts with it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { notesFor } from "../scripts/release-notes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANGELOG = [
    "# Changelog",
    "",
    "## [0.2.2] - 2026-11-09",
    "",
    "### Changed",
    "",
    "- The newer entry.",
    "",
    "## [0.2.1] - 2026-11-08",
    "",
    "### Fixed",
    "",
    "- The older entry.",
].join("\n");

/** Runs the script against a throwaway changelog. */
function run(changelog: string, version: string): { status: number | null; output: string } {
    const root = mkdtempSync(path.join(tmpdir(), "jig-bedrock-notes-"));
    try {
        writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
        const result = spawnSync(
            process.execPath,
            [path.join(ROOT, "scripts/release-notes.mjs"), version, "--root", root],
            { encoding: "utf8" },
        );
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("prints one release's entries, without its heading or another release's", () => {
    assert.equal(notesFor(CHANGELOG, "0.2.2"), "### Changed\n\n- The newer entry.");
});

test("a section with nothing after it runs to the end of the file", () => {
    assert.equal(notesFor(CHANGELOG, "0.2.1"), "### Fixed\n\n- The older entry.");
});

test("a version does not match a longer version with the same prefix", () => {
    assert.equal(notesFor("## [0.2.10] - 2026-11-09\n\n- Entry.", "0.2.1"), undefined);
});

test("a missing or empty section is not a release", () => {
    assert.equal(notesFor(CHANGELOG, "0.9.9"), undefined);
    assert.equal(notesFor(`${CHANGELOG}\n\n## [0.3.0] - 2026-12-01\n`, "0.3.0"), "");
});

test("the command prints the notes, and fails when the changelog has no such section", () => {
    const found = run(CHANGELOG, "0.2.1");
    assert.equal(found.status, 0, found.output);
    assert.equal(found.output, "### Fixed\n\n- The older entry.\n");

    const missing = run(CHANGELOG, "0.9.9");
    assert.equal(missing.status, 1, missing.output);
    assert.match(missing.output, /no section ## \[0\.9\.9\] with entries/);
});

test("this repository's changelog has a section for the published version", () => {
    const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const notes = notesFor(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), version);
    assert.equal(typeof notes, "string");
    assert.match(notes ?? "", /\S/);
});
