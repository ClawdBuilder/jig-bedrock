// Scans this public tree for company words supplied from outside it. The word list is never in the repo: point
// JIG_SCAN_WORDS at a private file (default ~/.config/jig/scan-words.txt). Without it, only secret shapes are checked.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wordFile = process.env.JIG_SCAN_WORDS || path.join(homedir(), ".config", "jig", "scan-words.txt");
const wordText = process.env.JIG_SCAN_WORDS_TEXT;
let words = [];
let note = "secrets only (no word list)";
if (wordText !== undefined) {
    // CI passes the private list as a repository secret; it is newline-separated text.
    words = wordText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    note = `${words.length} private words (secret)`;
} else {
    try {
        words = readFileSync(wordFile, "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        note = `${words.length} private words`;
    } catch {}
}
const BANNED =
    words.length === 0
        ? undefined
        : new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const SECRET = /(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
let bad = 0;
function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(ts|js|md|json|mjs|yml|yaml|txt)$/.test(entry.name)) {
            const relative = path.relative(ROOT, file);
            const lines = readFileSync(file, "utf8").split("\n");
            for (let index = 0; index < lines.length; index++) {
                const line = lines[index] ?? "";
                if (SECRET.test(line) || (BANNED && BANNED.test(line))) {
                    // Only the location: the matched word and its context stay out of the log.
                    console.log(`${relative}:${index + 1}`);
                    bad++;
                }
            }
        }
    }
}
walk(ROOT);
console.log(`scan: ${bad} hits, ${note}`);
process.exit(bad === 0 ? 0 : 1);
