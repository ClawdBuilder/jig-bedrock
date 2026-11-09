// The published package must contain the pages its README links to. `npm pack --dry-run --json` gives the exact file
// list npm would publish, so a link to a file left out of "files" fails here instead of in an installed Pi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

/** Every path npm would put in the tarball. npm 10/11 print an array; npm 12 prints an object keyed by package name. */
function packedFiles(): string[] {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
    return entries.flatMap((entry) => {
        const files = (entry as { files?: Array<{ path?: unknown }> }).files ?? [];
        return files.flatMap((file) => (typeof file.path === "string" ? [file.path] : []));
    });
}

test("every relative link in README.md resolves inside the published package", () => {
    const files = new Set(packedFiles());
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    const links = [...readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
        .map((match) => match[1] ?? "")
        .filter((target) => target !== "" && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target));
    assert.ok(links.length > 0, "the README has relative links");
    for (const target of links) {
        const path = target.split("#")[0] ?? "";
        assert.ok(files.has(path), `README links ${target}, which npm pack does not publish`);
    }
});
