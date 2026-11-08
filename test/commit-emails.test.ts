// The commit-email guard reads a fake git log here: with the private word list a matching author or committer fails,
// without it only the built-in public identities pass and every other address warns.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/check-commit-emails.mjs", import.meta.url).pathname;

function run(log: string, list?: string): { status: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "jig-bedrock-emails-"));
    try {
        const logFile = join(dir, "git-log");
        writeFileSync(logFile, log);
        const env: NodeJS.ProcessEnv = { ...process.env, JIG_GIT_LOG: logFile };
        if (list === undefined) delete env.JIG_SCAN_WORDS;
        else {
            const listFile = join(dir, "scan-words.txt");
            writeFileSync(listFile, list);
            env.JIG_SCAN_WORDS = listFile;
        }
        try {
            return {
                status: 0,
                output: execFileSync(process.execPath, [script], { encoding: "utf8", env }),
            };
        } catch (error) {
            const failed = error as { status?: number; stdout?: string; stderr?: string };
            return { status: failed.status ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const line = (sha: string, author: string, committer: string) => `${sha}\x1f${author}\x1f${committer}\n`;
const good = line("a".repeat(40), "noreply@example.com", "someone@users.noreply.github.com");
const maintainer = line("b".repeat(40), "mrigankamondal10@gmail.com", "mrigankamondal10@gmail.com");
const badAuthor = line("c".repeat(40), "person@private.example", "noreply@example.com");
const badCommitter = line("d".repeat(40), "noreply@example.com", "person@private.example");

test("a private word in the author email fails", () => {
    const result = run(badAuthor, "private\n");
    assert.equal(result.status, 1);
    assert.match(result.output, /author email matches the private list/);
});

test("a private word in the committer email fails", () => {
    const result = run(badCommitter, "private\n");
    assert.equal(result.status, 1);
    assert.match(result.output, /committer email matches the private list/);
});

test("without the list only public identities pass", () => {
    const result = run(good);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.output, /^warn /m);
});

test("the maintainer's public address passes without the list", () => {
    const result = run(maintainer);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.output, /^warn /m);
});

test("without the list an unknown address warns and still succeeds", () => {
    const result = run(line("e".repeat(40), "person@private.example", "noreply@example.com"));
    assert.equal(result.status, 0);
    assert.match(result.output, /warn .*author email is not a public identity/);
});

test("a clean list run says clean", () => {
    const result = run(good, "private\n");
    assert.equal(result.status, 0);
    assert.match(result.output, /clean in/);
});
