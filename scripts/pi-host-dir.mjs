import path from "node:path";

// The Pi package Jig runs in: PI_HOST_DIR, else Pi's global npm install next to this Node
// (<prefix>/bin/node, <prefix>/lib/node_modules/@earendil-works/pi-coding-agent). Pi's own dependencies
// (typebox, pi-ai, pi-tui, the AWS SDK) are in its node_modules, as a global install lays them out.
export const piHostDir =
    process.env.PI_HOST_DIR ||
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
