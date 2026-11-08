// Scans this public tree for company words supplied from outside it. The word list is never in the repo: point
// JIG_SCAN_WORDS at a private file (default ~/.config/jig/scan-words.txt). Without it, only secret shapes are checked.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const wordFile = process.env.JIG_SCAN_WORDS || path.join(homedir(), ".config", "jig", "scan-words.txt");
let words = [];
let note = "secrets only (no word file)";
try {
    words = readFileSync(wordFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    note = `${words.length} private words`;
} catch {}
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
            const text = readFileSync(file, "utf8");
            if (SECRET.test(text) || (BANNED && BANNED.test(text))) {
                console.log(path.relative(ROOT, file));
                bad++;
            }
        }
    }
}
walk(ROOT);
console.log(`scan: ${bad} files, ${note}`);
process.exit(bad === 0 ? 0 : 1);
