// Fails when an author or committer email in the checked range matches the private scan list. The list is never in this
// repository: point JIG_SCAN_WORDS at it, or leave the default ~/.config/jig/scan-words.txt. Without a list (a fork's CI)
// only the built-in public identities pass and every other address warns, so a fork is not blocked by a missing file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Addresses a public commit may use without the private list. */
const PUBLIC = [/^noreply@example\.com$/i, /^[^@\s]+@users\.noreply\.github\.com$/i, /^mrigankamondal10@gmail\.com$/i];

const wordFile = process.env.JIG_SCAN_WORDS || path.join(homedir(), ".config", "jig", "scan-words.txt");
let words = [];
try {
    words = readFileSync(wordFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
} catch {
    // No file: warn-only mode.
}

const range =
    process.env.JIG_COMMIT_RANGE ||
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}..HEAD` : "origin/main..HEAD");

/** The fake log seam the tests use; otherwise git itself. */
function gitLog() {
    const fake = process.env.JIG_GIT_LOG;
    if (fake !== undefined) return readFileSync(fake, "utf8");
    return execFileSync("git", ["log", "--format=%H%x1f%ae%x1f%ce", range], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
}

let output;
try {
    output = gitLog();
} catch {
    console.log(`commit emails: skipped (range ${range} is unavailable)`);
    process.exit(0);
}

const isPublic = (email) => PUBLIC.some((pattern) => pattern.test(email));
const blocked =
    words.length === 0
        ? undefined
        : new RegExp(`\\b(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

let bad = 0;
let warned = 0;
for (const line of output.split("\n")) {
    if (!line) continue;
    const [sha, author, committer] = line.split("\x1f");
    for (const [kind, email] of [
        ["author", author ?? ""],
        ["committer", committer ?? ""],
    ]) {
        if (blocked?.test(email) === true) {
            console.log(`${sha?.slice(0, 12)} ${kind} email matches the private list`);
            bad++;
        } else if (blocked === undefined && !isPublic(email)) {
            console.log(`warn ${sha?.slice(0, 12)} ${kind} email is not a public identity`);
            warned++;
        }
    }
}

if (bad > 0) {
    console.log(`commit emails: ${bad} match(es) in ${range}`);
    process.exit(1);
}
if (blocked === undefined) {
    console.log(`commit emails: ${warned} warning(s), no private list`);
} else {
    console.log(`commit emails: clean in ${range}`);
}
