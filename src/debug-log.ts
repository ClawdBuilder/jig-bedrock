// A debug log for working out why a request was slow or refused: one JSON line per request of this package, per discovery
// run and per sign-in repair, in `${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/debug.log`. It is off unless
// JIG_BEDROCK_DEBUG=1 or `debug: true` in bedrock.json; when off nothing is written and no file or folder is made.
//
// A line holds the time, the short model id, region, route, HTTP status, AWS request id, duration, token counts and, for a
// failure, the AWS error name and the first 300 characters of its message. Never a credential, a signature, an
// authorization header, a prompt, a reply or a tool argument: those are not read, and every text that is written passes
// through `redact`, which also turns an AWS account id into <account> and a full ARN into its last path segment.
import {
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    mkdirSync,
    openSync,
    renameSync,
    statSync,
    writeSync,
} from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogSource, Status } from "./aws-discovery.ts";
import { regionOf, stateFolder } from "./spend.ts";
import type { Recover, RecoveredBedrock } from "./sso.ts";
import { recoveryCategory } from "./sso.ts";

type Stream = NonNullable<ProviderConfig["streamSimple"]>;

/** The log passes this size, and the next line starts a fresh file (the old one becomes `debug.log.1`). */
export const MAX_LOG_BYTES = 5 * 1_048_576;
/** How much of an error message a line keeps. */
const MESSAGE_CHARS = 300;

/** Where the log is written: `${XDG_STATE_HOME:-~/.local/state}/jig-bedrock/debug.log`. */
export function debugLogPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(stateFolder(env), "debug.log");
}

/** Whether the log is on: JIG_BEDROCK_DEBUG=1 in the environment, or the `debug` setting. */
export function debugEnabled(env: NodeJS.ProcessEnv, config?: { debug?: boolean }): boolean {
    return env.JIG_BEDROCK_DEBUG === "1" || config?.debug === true;
}

/**
 * A text with nothing in it that must not be kept: a full ARN becomes its last path segment, a 12-digit AWS account id
 * becomes <account>, and an access key id, a signature, a credential scope or a bearer token is dropped.
 */
export function redact(text: string): string {
    return text
        .replace(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]*:[A-Za-z0-9:/_.+=,@*-]+/g, (arn) => {
            const resource = arn.split(":").slice(5).join(":");
            return resource.includes("/") ? (resource.split("/").pop() ?? "") : (arn.split(":").pop() ?? "");
        })
        .replace(/(?<![0-9])[0-9]{12}(?![0-9])/g, "<account>")
        .replace(/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA)[A-Z0-9]{16}\b/g, "<key>")
        .replace(/Credential=[^\s,]+/gi, "Credential=<redacted>")
        .replace(/Signature=[0-9a-f]+/gi, "Signature=<redacted>")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>");
}

/** One line of the log; `time` is added when it is written. */
export type DebugEntry = Record<string, unknown>;

export interface DebugLog {
    readonly enabled: boolean;
    /** Appends one line. It never throws: a log that cannot be written is dropped. */
    write(entry: DebugEntry): void;
}

export interface DebugLogOptions {
    enabled: boolean;
    env?: NodeJS.ProcessEnv;
    /** The size after which the file is moved to `debug.log.1`; a test passes a small one. */
    maxBytes?: number;
    now?: () => Date;
}

export function createDebugLog(options: DebugLogOptions): DebugLog {
    const env = options.env ?? process.env;
    const now = options.now ?? (() => new Date());
    const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    const file = debugLogPath(env);
    return {
        enabled: options.enabled,
        write(entry) {
            if (!options.enabled) return;
            try {
                const folder = join(file, "..");
                mkdirSync(folder, { recursive: true, mode: 0o700 });
                try {
                    if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
                const line = `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`;
                // The file is private, and a link at its place is not followed.
                const fd = openSync(
                    file,
                    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
                    0o600,
                );
                try {
                    fchmodSync(fd, 0o600);
                    writeSync(fd, line);
                } finally {
                    closeSync(fd);
                }
                try {
                    chmodSync(folder, 0o700);
                } catch {}
            } catch {}
        },
    };
}

const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The header's value whatever its case, or undefined. */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (headers === undefined) return undefined;
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
    return undefined;
}

/** What Pi's Bedrock Converse stream adds to a failed message: the status, AWS error name and request id it saw. */
function failureDetails(message: AssistantMessage): { status?: number; errorCode?: string; requestId?: string } {
    for (const diagnostic of message.diagnostics ?? []) {
        if (diagnostic.type !== "bedrock_response_failure") continue;
        const details = diagnostic.details as Record<string, unknown> | undefined;
        const status = number(details?.status);
        return {
            ...(status === undefined ? {} : { status }),
            ...(typeof details?.errorCode === "string" ? { errorCode: details.errorCode } : {}),
            ...(typeof details?.requestId === "string" ? { requestId: details.requestId } : {}),
        };
    }
    return {};
}

/**
 * The same streams, each writing one line when its request ends: the model, region, route, status, request id, time and
 * tokens. The status and headers come from the signed fetch (Messages) or the response callback (Converse), and the tokens from
 * Pi's own final message, so no response body is read here. With the log off the streams come back as they are.
 */
export function withDebugLog(
    recovered: RecoveredBedrock,
    log: DebugLog,
    clock: () => number = Date.now,
): RecoveredBedrock {
    if (!log.enabled) return recovered;
    const wrap = (inner: Stream): Stream => {
        return (model, context, options) => {
            const started = clock();
            let status: number | undefined;
            let requestId: string | undefined;
            let errorType: string | undefined;
            let attempts = 0;
            const seen = (code: number, headers: Record<string, string>): void => {
                attempts++;
                status = code;
                requestId = header(headers, "x-amzn-requestid") ?? header(headers, "x-amzn-request-id");
                errorType = header(headers, "x-amzn-errortype")?.split(":")[0];
            };
            const send = options?.fetch;
            const scoped = {
                ...options,
                // Pi calls this when a response arrives, but only for an answer that is not an error: the Messages client
                // throws first. The signed fetch below sees every answer, so a refusal keeps its status and request id.
                onResponse: async (...args: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>) => {
                    if (send === undefined) seen(args[0].status, args[0].headers);
                    await options?.onResponse?.(...args);
                },
                ...(send === undefined
                    ? {}
                    : {
                          fetch: async (...args: Parameters<typeof fetch>) => {
                              const response = await send(...args);
                              seen(response.status, Object.fromEntries(response.headers.entries()));
                              return response;
                          },
                      }),
            };
            const base = {
                event: "request",
                model: redact(model.id),
                region: regionOf(model.baseUrl ?? ""),
                route: model.api === "anthropic-messages" ? "messages" : "converse",
            };
            const failed = (error: string, text: string, extra: { status?: number; requestId?: string } = {}) =>
                log.write({
                    ...base,
                    ...((extra.status ?? status) === undefined ? {} : { status: extra.status ?? status }),
                    ...((extra.requestId ?? requestId) === undefined
                        ? {}
                        : { requestId: extra.requestId ?? requestId }),
                    ms: clock() - started,
                    ...(attempts > 1 ? { attempts } : {}),
                    error,
                    message: redact(text).slice(0, MESSAGE_CHARS),
                });
            let stream: ReturnType<Stream>;
            try {
                stream = inner(model, context, scoped as typeof options);
            } catch (error) {
                failed(
                    error instanceof Error && error.name !== "Error" ? error.name : "Error",
                    String(error instanceof Error ? error.message : error),
                );
                throw error;
            }
            void stream.result().then(
                (message) => {
                    if (message.stopReason === "error" || message.stopReason === "aborted") {
                        const details = failureDetails(message);
                        failed(
                            message.stopReason === "aborted"
                                ? "Aborted"
                                : (details.errorCode ?? errorType ?? "Unknown"),
                            message.errorMessage ?? "",
                            details,
                        );
                        return;
                    }
                    const usage = message.usage;
                    log.write({
                        ...base,
                        ...(status === undefined ? {} : { status }),
                        ...(requestId === undefined ? {} : { requestId }),
                        ms: clock() - started,
                        ...(attempts > 1 ? { attempts } : {}),
                        ...(number(usage?.input) === undefined ? {} : { input: usage.input }),
                        ...(number(usage?.output) === undefined ? {} : { output: usage.output }),
                        ...(number(usage?.cacheRead) === undefined ? {} : { cacheRead: usage.cacheRead }),
                        ...(number(usage?.cacheWrite) === undefined ? {} : { cacheWrite: usage.cacheWrite }),
                    });
                },
                () => {},
            );
            return stream;
        };
    };
    return {
        provider: {
            ...recovered.provider,
            stream: wrap(recovered.provider.stream as Stream) as typeof recovered.provider.stream,
            streamSimple: wrap(recovered.provider.streamSimple),
        },
        ...(recovered.messages
            ? {
                  messages: {
                      stream: wrap(recovered.messages.stream),
                      streamSimple: wrap(recovered.messages.streamSimple),
                  },
              }
            : {}),
    };
}

/** The catalog source with one line per refresh: the mode, regions, how many models, how long, and the error if it failed. */
export function withDebugCatalog(
    catalog: CatalogSource,
    log: DebugLog,
    describe: () => { mode?: string; regions: readonly string[] },
    clock: () => number = Date.now,
): CatalogSource {
    if (!log.enabled) return catalog;
    return {
        load: () => catalog.load(),
        failure: () => catalog.failure?.(),
        async refresh(force) {
            const started = clock();
            const before = catalog.load()?.fetched_at;
            const { mode, regions } = describe();
            let status: Status;
            try {
                status = await catalog.refresh(force);
            } catch (error) {
                log.write({
                    event: "discovery",
                    mode,
                    regions,
                    ms: clock() - started,
                    error: error instanceof Error && error.name !== "Error" ? error.name : "Error",
                    message: redact(error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_CHARS),
                });
                throw error;
            }
            const after = catalog.load();
            log.write({
                event: "discovery",
                mode,
                regions,
                models: after?.profiles.length ?? 0,
                ms: clock() - started,
                status,
                // A fresh cache answered; nothing was asked of AWS.
                ...(status === "ok" && before !== undefined && after?.fetched_at === before ? { cached: true } : {}),
                ...(status === "ok"
                    ? {}
                    : { error: status, message: redact(catalog.failure?.() ?? "").slice(0, MESSAGE_CHARS) }),
            });
            return status;
        },
    };
}

/** The sign-in repair with one line per run: where it was asked from and whether it restored the session. */
export function withDebugRecover(recover: Recover, log: DebugLog, clock: () => number = Date.now): Recover {
    if (!log.enabled) return recover;
    return async (profile, signal, source) => {
        const started = clock();
        try {
            await recover(profile, signal, source);
            log.write({ event: "sign-in", source: source ?? "manual", outcome: "restored", ms: clock() - started });
        } catch (error) {
            log.write({
                event: "sign-in",
                source: source ?? "manual",
                outcome: "failed",
                category: recoveryCategory(error),
                ms: clock() - started,
            });
            throw error;
        }
    };
}
