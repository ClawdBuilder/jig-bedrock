import path from "node:path";
import { pathToFileURL } from "node:url";
import { piHostDir } from "../../scripts/pi-host-dir.mjs";

// Resolving from inside the Pi package finds its own dependencies and, one level up, Pi itself.
const parentURL = pathToFileURL(path.join(piHostDir, "host.mjs")).href;
const host = /^(?:typebox|@earendil-works\/pi-(?:coding-agent|tui|ai|agent-core))(?:\/|$)/;

export async function resolve(specifier, context, next) {
    return next(specifier, host.test(specifier) ? { ...context, parentURL } : context);
}
