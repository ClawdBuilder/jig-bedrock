// Sign in when Pi starts, so that no request has to fail first. In an interactive session, once at startup, the profile's SSO is
// checked (sso-check.ts); when it has expired the shared recovery starts at once, which is the one that /bedrock login and a failed
// request use, so there is one browser window however many of them need it. Nothing here waits: session start returns first.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Recover } from "./sso.ts";
import { recoveryHint, SsoRecoveryError } from "./sso.ts";
import type { SsoState } from "./sso-check.ts";

export interface StartSignIn {
    /** Whether an expired session signs in at once; false still checks read-only and says the models are not loaded. */
    signInAtStart?: boolean;
    /** The AWS profile the provider signs in with, resolved when the check runs; undefined means none is configured. */
    profile: () => string | undefined;
    /** The shared recovery (`shareRecovery`), the one /bedrock login and a request go through. */
    recover: Recover;
    check(profile: string, signal: AbortSignal): Promise<SsoState>;
    /** Called after a sign-in that finished: the catalog may have failed to load while the session was expired. */
    refresh(): Promise<unknown>;
}

/** A session with a screen: Pi's terminal UI or an RPC client. Print and JSON mode have none, and nobody is there to sign in. */
export const hasScreen = (ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean =>
    ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");

export function registerSignInAtStart(pi: ExtensionAPI, start: StartSignIn): void {
    let running: AbortController | undefined;
    const run = async (ctx: ExtensionContext, signal: AbortSignal): Promise<void> => {
        // Let session start finish before anything is read: the check reads files and may load the AWS SDK.
        await new Promise((resolve) => setImmediate(resolve));
        if (signal.aborted) return;
        const profile = start.profile();
        if (profile === undefined) return;
        const state = await start.check(profile, signal);
        if (state !== "sign-in" || signal.aborted) return;
        if (start.signInAtStart === false) {
            ctx.ui.notify("Bedrock models not loaded yet; run /bedrock login, then /bedrock refresh.", "warning");
            return;
        }
        ctx.ui.notify(`AWS sign-in for ${profile} has expired; signing in, your browser opens.`, "info");
        try {
            await start.recover(profile, signal, "warmup");
        } catch (error) {
            // A request that joined this sign-in tells its own failure (streamed); a shutdown is nobody's failure.
            if (!signal.aborted && !(error instanceof SsoRecoveryError && error.streamed)) {
                ctx.ui.notify(recoveryHint(error), "warning");
            }
            return;
        }
        if (signal.aborted) return;
        ctx.ui.notify(`AWS sign-in for ${profile} is restored.`, "info");
        await start.refresh().catch(() => {});
    };
    pi.on("session_start", (event, ctx) => {
        // Only when Pi starts: a reload, /new or /resume is the same process, and a window the user closed stays closed.
        if (event.reason !== "startup" || !hasScreen(ctx)) return;
        const controller = new AbortController();
        running = controller;
        void run(ctx, controller.signal).catch(() => {});
    });
    pi.on("session_shutdown", () => running?.abort());
}
