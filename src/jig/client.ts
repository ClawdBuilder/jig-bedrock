// How the Bedrock provider reaches jig-core at run time. A copy of jig-core's client.ts (plugins/jig-core/src/client.ts in Jig),
// kept identical apart from the import below: jig-core publishes its API on a process-wide symbol when it loads, and a provider
// keeps its own copy of this lookup instead of importing jig-core, so it loads in either order and can be split out.
// test/client.test.ts compares this file with the checkout in JIG_DIR, so a change in Jig's copy fails there.
import type { JigApi } from "./types.ts";

const API = Symbol.for("jig.core.api/v1");
const PENDING = Symbol.for("jig.core.pending/v1");

type Slot = typeof globalThis & {
    [API]?: JigApi;
    [PENDING]?: Array<(api: JigApi) => void>;
};

const slot = globalThis as Slot;

/** The API when jig-core has already loaded; undefined in plain Pi. */
export function jigApi(): JigApi | undefined {
    return slot[API];
}

/** jig-core's API. Throws when jig-core is not loaded, so a Jig tool fails closed instead of running
 *  ungoverned. */
export function jig(): JigApi {
    const api = slot[API];
    if (api === undefined) throw new Error("jig-core is not loaded: enable jig-core, which governs every Jig tool");
    return api;
}

/** Runs `use` now if jig-core is loaded, otherwise as soon as it loads. */
export function withJig(use: (api: JigApi) => void): void {
    const api = slot[API];
    if (api !== undefined) {
        use(api);
        return;
    }
    const pending = slot[PENDING] ?? [];
    slot[PENDING] = pending;
    pending.push(use);
}

/** For jig-core only: publishes the API and runs what plugins queued before it loaded. One plugin's failing
 *  callback does not stop the others: every callback runs, and the errors come back for jig-core to report. */
export function publishJig(api: JigApi): unknown[] {
    slot[API] = api;
    const pending = slot[PENDING] ?? [];
    slot[PENDING] = [];
    const errors: unknown[] = [];
    for (const use of pending) {
        try {
            use(api);
        } catch (error) {
            errors.push(error);
        }
    }
    return errors;
}

/** For jig-core only: withdraws the API when its runtime ends (reload, session replacement, exit), so a plugin
 *  loading into the next runtime waits for the new jig-core instead of declaring into the old one. */
export function withdrawJig(api: JigApi): void {
    if (slot[API] === api) delete slot[API];
}
