// How the Bedrock provider reaches jig-core at run time: the same two process-wide symbols jig-core publishes on, so the
// provider loads before or after jig-core and never imports it. This is only the lookup half of jig-core's own
// `plugins/jig-core/src/client.ts`; jig-bedrock never publishes or withdraws, and no test compares the files byte for byte.
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
