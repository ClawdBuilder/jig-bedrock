// Where Pi is installed, to load the AWS SDK the way Pi's own Bedrock provider does. Pi gives an extension its own packages but not
// the SDK behind them, which sits in Pi's install; `createRequire` from there finds it. It checks the install the running `pi`
// command belongs to first, found by walking up from the real path of the script Node was started with, then PI_HOST_DIR and the
// global npm install next to this Node.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function isPi(dir: string): boolean {
    try {
        return (
            (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name === PI_PACKAGE
        );
    } catch {
        return false;
    }
}

/**
 * Pi's package folder. `PI_HOST_DIR` wins when it is set (it is the folder, taken as it is). Otherwise the folder above the script
 * Node started (`argv1`, with links followed) that is Pi's package, then the global npm install beside `execPath`. Undefined when
 * none is Pi.
 */
export function findPiHost(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    argv1: string | undefined = process.argv[1],
): string | undefined {
    if (env.PI_HOST_DIR) return env.PI_HOST_DIR;
    if (argv1) {
        try {
            for (let dir = path.dirname(realpathSync(argv1)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
                if (isPi(dir)) return dir;
            }
        } catch {
            // The script is gone or unreadable: try the next place.
        }
    }
    const beside = path.resolve(path.dirname(execPath), "../lib/node_modules", PI_PACKAGE);
    return isPi(beside) ? beside : undefined;
}

/** What the SDK's `defaultProvider` takes and gives: a function that resolves the profile's credentials when called. */
export type CredentialProvider = (init?: { profile?: string }) => () => Promise<unknown>;

/** `defaultProvider` of the SDK in Pi's install. Throws when Pi or the SDK cannot be found. */
export function loadCredentialProvider(host: string | undefined): CredentialProvider {
    if (!host) throw new Error("Pi's install was not found");
    const require = createRequire(path.join(host, "package.json"));
    const { defaultProvider } = require("@aws-sdk/credential-provider-node") as { defaultProvider: CredentialProvider };
    return defaultProvider;
}
