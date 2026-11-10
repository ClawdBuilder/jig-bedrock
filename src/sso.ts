import type { AssistantMessage, AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { profilePattern } from "./config.ts";
import { isOwnModel } from "./identity.ts";
import { NO_PROFILE } from "./profile.ts";

type Stream = NonNullable<ProviderConfig["streamSimple"]>;

/** Both of Pi's Bedrock-capable streams, each wrapped so a request that failed on an expired SSO session is replayed once. */
export interface RecoveredBedrock {
    provider: import("@earendil-works/pi-ai").Provider;
    /** Pi's Anthropic Messages stream, for Bedrock's `/anthropic` route. */
    messages?: { stream: Stream; streamSimple: Stream };
}
export type Recover = (
    profile: string,
    signal?: AbortSignal,
    source?: "request" | "manual" | "warmup",
) => Promise<void>;
export type RecoveryCategory = "runtime" | "helper" | "browser" | "timeout" | "cancelled" | "login" | "profile";
export class SsoRecoveryError extends Error {
    category: RecoveryCategory;
    streamed: boolean;
    /** The plain message for a profile that cannot be used, when the category alone cannot say it. */
    detail?: string;
    constructor(category: RecoveryCategory, streamed = false, detail?: string) {
        super(detail ?? `AWS SSO recovery did not complete (${category}).`);
        this.category = category;
        this.streamed = streamed;
        this.detail = detail;
    }
}
export function recoveryCategory(error: unknown): RecoveryCategory {
    return error instanceof SsoRecoveryError ? error.category : "login";
}
export function recoveryHint(error: unknown): string {
    if (error instanceof SsoRecoveryError && error.detail !== undefined) return error.detail;
    switch (recoveryCategory(error)) {
        case "runtime":
            return "AWS SSO recovery could not use a private runtime directory. Check ownership and permissions of your home runtime directory, then run /aws-login.";
        case "browser":
            return "AWS SSO recovery could not find a usable browser opener. Check the configured opener and desktop or WSL interop, then run /aws-login.";
        case "helper":
            return "AWS SSO login helper is unavailable. Check the workstation AWS SSO installation, then run /aws-login.";
        case "timeout":
            return "AWS SSO recovery timed out. Check browser sign-in and network access, then run /aws-login.";
        case "cancelled":
            return "AWS SSO recovery cancelled.";
        case "profile":
            return "Check the AWS profile: it must exist and be an IAM Identity Center (SSO) profile, then run /aws-login.";
        default:
            return "AWS SSO recovery did not complete. Finish browser sign-in or run /aws-login, then continue.";
    }
}
const shared = new WeakMap<Recover, Recover>();
/** One helper per profile; a cancelled subscriber cannot cancel other callers. */
export function shareRecovery(recovery: Recover): Recover {
    const existing = shared.get(recovery);
    if (existing) return existing;
    const flights = new Map<
        string,
        { controller: AbortController; callers: Set<object>; requested: boolean; promise: Promise<void> }
    >();
    const recover: Recover = (profile, signal, source = "manual") => {
        if (signal?.aborted) return Promise.reject(new SsoRecoveryError("cancelled"));
        let flight = flights.get(profile);
        if (flight?.controller.signal.aborted) {
            flights.delete(profile);
            flight = undefined;
        }
        if (!flight) {
            const controller = new AbortController();
            flight = { controller, callers: new Set(), requested: false, promise: undefined! };
            const current = flight;
            current.promise = Promise.resolve()
                .then(() => recovery(profile, controller.signal))
                .catch((error) => {
                    throw new SsoRecoveryError(
                        controller.signal.aborted ? "cancelled" : recoveryCategory(error),
                        current.requested,
                        error instanceof SsoRecoveryError ? error.detail : undefined,
                    );
                })
                .finally(() => {
                    if (flights.get(profile) === current) flights.delete(profile);
                });
            flights.set(profile, current);
        }
        if (source === "request") flight.requested = true;
        const current = flight,
            caller = {};
        current.callers.add(caller);
        return new Promise<void>((resolve, reject) => {
            let finished = false;
            const done = (error?: unknown) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener("abort", abort);
                current.callers.delete(caller);
                error ? reject(error) : resolve();
            };
            const abort = () => {
                done(new SsoRecoveryError("cancelled", source === "request"));
                if (!current.callers.size) current.controller.abort();
            };
            signal?.addEventListener("abort", abort, { once: true });
            current.promise.then(
                () => done(),
                (error) => done(error),
            );
            if (signal?.aborted) abort();
        });
    };
    shared.set(recovery, recover);
    shared.set(recover, recover);
    return recover;
}
/** Only our sanitized recovery terminal errors suppress the generic provider notice. */
export function isPresentedSsoFailure(message: { errorMessage?: string }): boolean {
    return (
        /^AWS SSO recovery (?:failed|cancelled|could not|timed out|did not complete)/.test(
            message.errorMessage ?? "",
        ) || /^AWS SSO login helper is unavailable\./.test(message.errorMessage ?? "")
    );
}
type Notice = (text: string, level: "info" | "warning") => void;

/** The TUI shows notices; print, JSON and RPC modes have no notice area, so a waiting sign-in is announced on stderr. */
export function noticeFor(
    ctx: { mode?: string; ui: { notify(text: string, level: "info" | "warning"): void } },
    write: (line: string) => void = (line) => {
        process.stderr.write(line);
    },
): Notice {
    return ctx.mode === "tui" ? (text, level) => ctx.ui.notify(text, level) : (text) => write(`jig-bedrock: ${text}\n`);
}

/** Only a local SSO credential failure, before any response, can be replayed. */
export function isSsoExpiry(message: AssistantMessage): boolean {
    return (
        message.stopReason === "error" &&
        message.content.length === 0 &&
        !message.usage?.totalTokens &&
        !message.usage?.input &&
        !message.usage?.output &&
        !message.usage?.cacheRead &&
        !message.usage?.cacheWrite &&
        !message.usage?.cost?.total &&
        /SSO session/i.test(message.errorMessage ?? "") &&
        /aws sso login/i.test(message.errorMessage ?? "")
    );
}

/** A failed request keeps its cause: the AWS name, message, HTTP status and request id, and no stack or headers. */
export function requestFailureMessage(error: unknown): string {
    if (!(error instanceof Error)) return "Bedrock request failed.";
    const value = error as Error & {
        code?: unknown;
        statusCode?: unknown;
        status?: unknown;
        $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
    };
    const name = error.name !== "Error" ? error.name : typeof value.code === "string" ? value.code : undefined;
    const status = value.$metadata?.httpStatusCode ?? value.statusCode ?? value.status;
    const requestId = value.$metadata?.requestId;
    return [
        ...(name === undefined ? [] : [`${name}:`]),
        error.message === "" ? "no message" : error.message,
        ...(typeof status === "number" ? [`HTTP ${status}`] : []),
        ...(typeof requestId === "string" ? [`request id ${requestId}`] : []),
    ].join(" ");
}

export function profileFor(options?: SimpleStreamOptions): string | undefined {
    // The Messages route gets a literal placeholder key because Pi's Anthropic client requires one before it builds a
    // request; the signed fetch removes it. It is not a real key and must not hide the profile from recovery.
    const placeholderKey = options?.apiKey === "bedrock-sigv4";
    if (
        (options?.apiKey && !placeholderKey) ||
        (options as SimpleStreamOptions & { bearerToken?: string })?.bearerToken ||
        (options?.env?.AWS_BEDROCK_SKIP_AUTH ?? process.env.AWS_BEDROCK_SKIP_AUTH) === "1"
    )
        return;
    const profile =
        (options as SimpleStreamOptions & { profile?: string })?.profile ||
        options?.env?.AWS_PROFILE ||
        process.env.AWS_PROFILE ||
        process.env.AWS_DEFAULT_PROFILE ||
        "default";
    return profilePattern.test(profile) ? profile : undefined;
}

/** Keep native Bedrock streaming/auth; retry the same request once, never an agent turn. */
export function withSsoRecovery(
    native: Stream,
    makeStream: () => AssistantMessageEventStream,
    recover: Recover,
    notify: Notice,
): Stream {
    recover = shareRecovery(recover);
    return (model, context, options) => {
        const output = makeStream();
        void (async () => {
            let responded = false;
            let localSignInFailure = false;
            let emitted = false;
            let approvedPayload: Promise<unknown> | undefined;
            const scoped = {
                ...options,
                // This is one logical request. Reuse its exact screened payload and do
                // not charge another child turn or rerun request hooks after login.
                onPayload: (payload: unknown, selected: typeof model) => {
                    approvedPayload ??= Promise.resolve(options?.onPayload?.(payload, selected)).then((replacement) =>
                        replacement === undefined ? payload : replacement,
                    );
                    return approvedPayload;
                },
                onResponse: async (...args: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>) => {
                    responded = true;
                    const [response] = args;
                    localSignInFailure = Object.entries(response.headers).some(
                        ([name, value]) => name.toLowerCase() === "x-jig-sso-expiry" && value === "1",
                    );
                    await options?.onResponse?.(...args);
                },
            };
            for (let attempt = 0; attempt < 2; attempt++) {
                let retry = false;
                for await (const event of native(model, context, scoped)) {
                    const profile = event.type === "error" && profileFor(options);
                    if (
                        attempt === 0 &&
                        profile &&
                        (localSignInFailure || (!responded && !emitted)) &&
                        !options?.signal?.aborted &&
                        isSsoExpiry(event.error)
                    ) {
                        notify(`Restoring AWS SSO (${profile}); browser sign-in or MFA may be needed.`, "info");
                        try {
                            await recover(profile, options?.signal, "request");
                            options?.signal?.throwIfAborted();
                            notify("AWS SSO restored. Resuming the same model request.", "info");
                            retry = true;
                            break;
                        } catch (failure) {
                            // Never expose helper output: login URLs/codes must not enter
                            // model context, session files, telemetry or error messages.
                            const aborted = options?.signal?.aborted;
                            const error = {
                                ...event.error,
                                stopReason: aborted ? "aborted" : "error",
                                errorMessage: aborted ? "AWS SSO recovery cancelled." : recoveryHint(failure),
                            } as AssistantMessage;
                            output.push({ type: "error", reason: error.stopReason as "aborted" | "error", error });
                            return;
                        }
                    }
                    emitted = true;
                    output.push(event);
                    if (event.type === "done" || event.type === "error") return;
                }
                if (!retry) throw new Error("Incomplete Bedrock stream");
            }
        })().catch((error) => {
            output.push({
                type: "error",
                reason: options?.signal?.aborted ? "aborted" : "error",
                error: {
                    role: "assistant",
                    content: [],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: options?.signal?.aborted ? "aborted" : "error",
                    timestamp: Date.now(),
                    errorMessage: options?.signal?.aborted
                        ? "Bedrock request cancelled."
                        : requestFailureMessage(error),
                },
            });
        });
        return output;
    };
}

/** Bounded helper process; its output is deliberately never captured. */
export async function registerBedrockSsoRecovery(
    pi: ExtensionAPI,
    recovery: Recover,
    defaultProfile?: () => string | undefined,
    check?: (profile: string, signal?: AbortSignal) => Promise<string | undefined>,
): Promise<RecoveredBedrock> {
    // Not worth deferring: Pi has already loaded both modules, so inside Pi these imports and builtinProviders() take about 1-5 ms
    // together (measured), while the models for /model need the native provider's metadata at registration anyway.
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const native = builtinProviders().find((provider) => provider.id === "amazon-bedrock");
    if (!native) throw new Error("Pi Bedrock provider is unavailable; check the Pi installation.");
    const lifetime = new AbortController();
    const sharedRecovery = shareRecovery(recovery);
    const recover: Recover = (profile, signal, source) =>
        sharedRecovery(profile, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal, source);
    // This forwarder already joins the shared flight. A second coordinator would
    // hide a request subscriber from warmup/manual failure presentation.
    shared.set(recover, recover);
    let notice: Notice = () => {};
    pi.on("session_start", (_event, ctx) => {
        notice = noticeFor(ctx);
    });
    pi.on("session_shutdown", () => lifetime.abort());
    pi.registerCommand("aws-login", {
        description: "Restore the selected AWS SSO profile (browser sign-in may be needed)",
        handler: async (args, ctx) => {
            const auth =
                ctx.model && isOwnModel(ctx.model) ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model) : undefined;
            const fromEnvironment = profileFor(auth?.ok ? auth : undefined);
            const profile =
                args.trim() || defaultProfile?.() || (fromEnvironment === "default" ? undefined : fromEnvironment);
            if (!profile) {
                ctx.ui.notify(NO_PROFILE, "warning");
                return;
            }
            if (!profilePattern.test(profile)) {
                ctx.ui.notify("Use /aws-login [AWS profile name].", "warning");
                return;
            }
            const problem = await check?.(profile, ctx.signal);
            if (problem !== undefined) {
                ctx.ui.notify(problem, "warning");
                return;
            }
            ctx.ui.notify(`Restoring AWS SSO (${profile}); complete any browser sign-in.`, "info");
            try {
                await recover(profile, ctx.signal);
                ctx.ui.notify("AWS SSO restored. Continue your request.", "info");
            } catch (error) {
                if (!(error instanceof SsoRecoveryError && error.streamed) && !lifetime.signal.aborted)
                    ctx.ui.notify(recoveryHint(error), "warning");
            }
        },
    });
    const notify: Notice = (text, level) => notice(text, level);
    // Keep both public stream entry points so full calls retain Bedrock options.
    const provider = {
        ...native,
        stream: withSsoRecovery(
            native.stream as Stream,
            createAssistantMessageEventStream,
            recover,
            notify,
        ) as typeof native.stream,
        streamSimple: withSsoRecovery(native.streamSimple, createAssistantMessageEventStream, recover, notify),
    };
    const anthropic = builtinProviders().find((candidate) => candidate.id === "anthropic");
    return {
        provider,
        ...(anthropic
            ? {
                  messages: {
                      stream: withSsoRecovery(
                          anthropic.stream as Stream,
                          createAssistantMessageEventStream,
                          recover,
                          notify,
                      ),
                      streamSimple: withSsoRecovery(
                          anthropic.streamSimple,
                          createAssistantMessageEventStream,
                          recover,
                          notify,
                      ),
                  },
              }
            : {}),
    };
}
