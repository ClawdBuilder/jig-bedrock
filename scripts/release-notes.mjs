// `node scripts/release-notes.mjs <version>`: the body of CHANGELOG.md's `## [<version>]` section, which the publish
// workflow gives to `gh release create --notes-file`. A section that is missing or empty is an error, so a tag with no
// entries written for it writes no release page.
//   node scripts/release-notes.mjs 0.2.2 [--root <folder>]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The lines under `## [<version>]`, up to the next `## ` heading, or undefined when there is no such heading. */
export function notesFor(changelog, version) {
    const lines = changelog.split("\n");
    const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?:\\s|$)`);
    const start = lines.findIndex((line) => heading.test(line));
    if (start === -1) return undefined;
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    const body = lines.slice(start + 1, end === -1 ? lines.length : end);
    while (body.length > 0 && (body[0] ?? "").trim() === "") body.shift();
    while (body.length > 0 && (body[body.length - 1] ?? "").trim() === "") body.pop();
    return body.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const version = args[0];
    if (version === undefined || version.startsWith("--")) {
        console.error("usage: node scripts/release-notes.mjs <version> [--root <folder>]");
        process.exit(2);
    }
    const index = args.indexOf("--root");
    const base = index === -1 ? path.join(path.dirname(process.argv[1]), "..") : (args[index + 1] ?? ".");
    const notes = notesFor(readFileSync(path.join(path.resolve(base), "CHANGELOG.md"), "utf8"), version);
    if (notes === undefined || notes === "") {
        console.error(`CHANGELOG.md has no section ## [${version}] with entries`);
        process.exit(1);
    }
    console.log(notes);
}
