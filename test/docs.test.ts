// The README and the pages under docs/ must stay true to the code: every setting is described, every variable named
// exists, every link and image points at a published file, the diagrams are well formed, and the word rule holds
// ("profile" is never used alone: "AWS profile" is the sign-in, "inference profile" is what AWS calls a model entry).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { BEDROCK_SUBCOMMANDS } from "../src/commands.ts";
import { FIELDS } from "../src/config.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(resolve(ROOT, file), "utf8");

/** The README and every page under docs/, as paths relative to the package root. */
const pages = [
    "README.md",
    ...readdirSync(resolve(ROOT, "docs"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/${name}`),
];

/** Names the pages may use before the code has them. Empty: every name on a page must exist in the code. */
const NOT_IN_CODE_YET = new Set<string>();

/** The text of a page without fenced code blocks. */
function withoutFences(text: string): string {
    return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
}

/** Every source file under src/, as one text. */
function sourceText(): string {
    const parts: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".ts")) parts.push(readFileSync(path, "utf8"));
        }
    };
    walk(resolve(ROOT, "src"));
    return parts.join("\n");
}

/** The setting names in the first column of the settings table in docs/settings.md. */
function documentedSettings(): string[] {
    const text = read("docs/settings.md");
    const section = /^## Every setting\n([\s\S]*?)^## /m.exec(text)?.[1] ?? "";
    return [...section.matchAll(/^\| `([A-Za-z]+)`\s*\|/gm)].map((match) => match[1] ?? "");
}

test("every setting in src/config.ts is in docs/settings.md, and every setting that page names exists", () => {
    const documented = documentedSettings();
    assert.ok(documented.length > 0, "docs/settings.md has the settings table under '## Every setting'");
    for (const name of FIELDS)
        assert.ok(documented.includes(name), `docs/settings.md does not describe the setting ${name}`);
    for (const name of documented)
        if (!(FIELDS as readonly string[]).includes(name))
            assert.ok(NOT_IN_CODE_YET.has(name), `docs/settings.md names ${name}, which src/config.ts does not have`);
});

test("every JIG_BEDROCK_ variable the pages name exists in src/, and every one in src/ is on a page", () => {
    const source = sourceText();
    const named = new Set<string>();
    for (const page of pages) for (const match of read(page).matchAll(/JIG_BEDROCK_[A-Z_]+/g)) named.add(match[0]);
    assert.ok(named.size > 0, "the pages name the JIG_BEDROCK_ variables");
    for (const name of named)
        if (!source.includes(name))
            assert.ok(NOT_IN_CODE_YET.has(name), `a page names ${name}, which src/ does not use`);
    const settings = read("docs/settings.md");
    for (const name of new Set(source.match(/JIG_BEDROCK_[A-Z_]+/g) ?? []))
        assert.ok(settings.includes(name), `src/ uses ${name}, which docs/settings.md does not name`);
});

/** The files npm publishes, from the `files` list of package.json: `dir/**` is a folder, anything else is one file. */
function published(path: string): boolean {
    const manifest = JSON.parse(read("package.json")) as { files: string[] };
    return manifest.files.some((pattern) =>
        pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
    );
}

/** GitHub's anchor for a heading: lower case, spaces to hyphens, everything but letters, digits, hyphens and underscores gone. */
const slug = (heading: string): string =>
    heading
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 _-]/g, "")
        .replace(/ /g, "-");

function anchorsOf(file: string): Set<string> {
    return new Set([...withoutFences(read(file)).matchAll(/^#{1,6} +(.+)$/gm)].map((match) => slug(match[1] ?? "")));
}

const RAW = "https://raw.githubusercontent.com/ClawdBuilder/jig-bedrock/main/";

test("every link and image in the pages points at a published file, and every #anchor at a heading", () => {
    let checked = 0;
    for (const page of pages) {
        const text = withoutFences(read(page));
        for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            const target = match[1] ?? "";
            const [location = "", fragment] = target.split("#");
            let file: string;
            if (target.startsWith(RAW)) file = location.slice(RAW.length);
            else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
            else file = location === "" ? page : relative(ROOT, resolve(ROOT, dirname(page), location));
            checked++;
            assert.ok(
                statSync(resolve(ROOT, file), { throwIfNoEntry: false })?.isFile(),
                `${page} links ${target}, which is not a file`,
            );
            assert.ok(
                published(file),
                `${page} links ${target}, which npm does not publish (see "files" in package.json)`,
            );
            if (fragment !== undefined && file.endsWith(".md"))
                assert.ok(anchorsOf(file).has(fragment), `${page} links ${target}, but ${file} has no such heading`);
        }
    }
    assert.ok(checked > 10, "the pages have links");
});

test("a README image uses the raw.githubusercontent.com address, which renders on GitHub, npm and the Pi gallery", () => {
    const readme = withoutFences(read("README.md"));
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
    assert.ok(images.length >= 2, "the README has its diagrams");
    for (const image of images)
        assert.ok(image.startsWith(`${RAW}docs/img/`), `${image} is not a ${RAW}docs/img/ address`);
});

test("no page uses 'the profile' or 'a profile' in prose: it is an AWS profile or an inference profile", () => {
    for (const page of pages) {
        const prose = withoutFences(read(page))
            .replace(/`[^`\n]*`/g, "")
            .replace(/\(https?:[^)]*\)/g, "");
        const lines = prose.split("\n");
        lines.forEach((line, index) => {
            assert.doesNotMatch(
                line,
                /\b(?:the|a) profiles?\b/i,
                `${page}:${index + 1} uses "profile" alone: ${line.trim().slice(0, 80)}`,
            );
        });
    }
});

test("the diagrams are accessible, small-text SVG with marker ids of their own", () => {
    const folder = resolve(ROOT, "docs/img");
    const files = readdirSync(folder).filter((name) => name.endsWith(".svg"));
    assert.deepEqual(files.sort(), ["cache-after-tool-load.svg", "discovery.svg", "request-flow.svg"]);
    const seen = new Map<string, string>();
    for (const name of files) {
        const svg = readFileSync(resolve(folder, name), "utf8");
        assert.match(svg, /<svg [^>]*role="img"/, `${name} has role="img"`);
        assert.match(svg, /<svg [^>]*aria-label="[^"]{40,}"/, `${name} has an aria-label that says what it shows`);
        for (const [, size] of svg.matchAll(/font-size="([\d.]+)"/g)) {
            const px = Number(size);
            assert.ok(px >= 11 && px <= 13, `${name} has text of ${px} px; it must be 11 to 13`);
        }
        for (const [, id] of svg.matchAll(/<marker id="([^"]+)"/g)) {
            assert.equal(seen.get(id ?? ""), undefined, `${name} reuses the marker id ${id} of ${seen.get(id ?? "")}`);
            seen.set(id ?? "", name);
        }
        for (const [, id] of svg.matchAll(/url\(#([^)]+)\)/g))
            assert.ok(seen.get(id ?? "") === name, `${name} uses a marker ${id} it does not define`);
    }
});

// The names of the /bedrock sub-commands (status, doctor, models, refresh, login, usage, budget, settings, set, unset,
// migrate, help) belong to the command branch of this release. src/commands.ts does not export the list yet, so this
// cannot compare the pages with the code. When it does, check that every `/bedrock <word>` in the pages is on the list.
test("every /bedrock sub-command the pages name exists, and help names every sub-command", () => {
    const names = new Set<string>(BEDROCK_SUBCOMMANDS);
    for (const page of pages) {
        for (const [, name] of withoutFences(read(page)).matchAll(/\/bedrock ([A-Za-z][A-Za-z-]*)/g)) {
            assert.ok(names.has(name ?? ""), `${page} names /bedrock ${name}, which src/commands.ts does not have`);
        }
    }
    const source = read("src/commands.ts");
    const help =
        /const HELP: Record<\(typeof BEDROCK_SUBCOMMANDS\)\[number\], string> = \{([\s\S]*?)^\};/m.exec(source)?.[1] ??
        "";
    for (const name of names)
        assert.match(help, new RegExp(`^    ${name}:`, "m"), `the /bedrock help text does not name ${name}`);
});
