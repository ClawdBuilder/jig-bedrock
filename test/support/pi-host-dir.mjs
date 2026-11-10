import path from "node:path";

// The Pi package the tests run against: the one this repository installs as a development dependency, so a contributor's global
// Pi and a CI runner (which has none) give the same result. Its own dependencies (typebox, pi-ai, pi-tui) are in its node_modules.
// The extension itself never reads Pi's install: the AWS SDK it needs is its own dependency.
export const piHostDir = path.resolve(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent");
