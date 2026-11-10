// Installs one Pi version over the pinned development dependency, without touching package.json or the lockfile, so the
// tests can run against a Pi other than the one the repository pins. This is what the "Pi versions" CI job runs.
//
//   node scripts/install-pi.mjs 1.5.0     the oldest Pi this package supports
//   node scripts/install-pi.mjs latest    the newest Pi on npm, asked of the registry now
//
// Pi's own packages release together, so one version number is installed for both of them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const npm = (args, options = {}) =>
    execFileSync("npm", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });

/** The version to install: the one asked for, or what npm reports as the newest published Pi. */
export function resolveVersion(request) {
    if (request === "latest") return npm(["view", PACKAGES[0], "version"]).trim();
    return request;
}

/** The version of an installed package, read from its own manifest. */
export function installedVersion(name) {
    return JSON.parse(readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version;
}

function main() {
    const request = process.argv[2];
    if (request === undefined) {
        console.error("usage: node scripts/install-pi.mjs <version|latest>");
        process.exit(2);
    }
    const version = resolveVersion(request);
    if (!VERSION.test(version)) {
        console.error(`"${request}" did not give a Pi version (got "${version}")`);
        process.exit(2);
    }
    console.log(`Pi ${version} (asked for ${request})`);
    npm(["install", "--no-save", "--no-audit", "--no-fund", ...PACKAGES.map((name) => `${name}@${version}`)], {
        stdio: "inherit",
    });
    for (const name of PACKAGES) {
        const got = installedVersion(name);
        console.log(`${name}@${got}`);
        if (got !== version) {
            console.error(`${name} is ${got}, not ${version}`);
            process.exit(1);
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
