// How the Bedrock tests reach Pi's own modules: the Pi package installed as a development dependency (test/support/pi-host-dir.mjs), through the
// resolve hook in test/support/host-hooks.mjs, so a plain import finds Pi's packages as Pi maps them for an extension at run time.
import { readFileSync } from "node:fs";
import path from "node:path";
import { piHostDir } from "./pi-host-dir.mjs";

export const host: string = piHostDir;
export const hostImport = (specifier: string): Promise<any> => import(specifier);
export const hostFile = (relative: string): string => path.join(host, relative);
export const hostVersion: string = JSON.parse(readFileSync(path.join(host, "package.json"), "utf8")).version;
