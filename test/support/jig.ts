// A stand-in jig-core for tests: it publishes the same global symbols Jig's own client uses and runs the callbacks plugins
// queued before it loaded, so a test can load the provider first and "load Jig" after it (or the other way round).
const API = Symbol.for("jig.core.api/v1");
const PENDING = Symbol.for("jig.core.pending/v1");

type Slot = typeof globalThis & {
    [API]?: unknown;
    [PENDING]?: Array<(api: never) => void>;
};

export function publishJigForTest(api: unknown): void {
    const slot = globalThis as Slot;
    slot[API] = api;
    const pending = slot[PENDING] ?? [];
    slot[PENDING] = [];
    for (const use of pending) use(api as never);
}

export function withdrawJigForTest(): void {
    delete (globalThis as Slot)[API];
}

/** Forget both symbols, so one test's fake jig-core cannot call the next test's callbacks. */
export function resetJigForTest(): void {
    const slot = globalThis as Slot;
    delete slot[API];
    delete slot[PENDING];
}
