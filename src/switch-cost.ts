import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOwnModel } from "./identity.ts";
import { type Cost, cacheWriteRate, type PromptCache, retentionFor } from "./prompt-cache.ts";

/** Below this the rewrite is pocket change and a notice would only be noise (Pi's own cache warming uses the same line). */
export const NOTICE_FLOOR_USD = 0.05;
const DEFAULT_TTL_SECONDS = { short: 300, long: 3600 };

export const tokensLabel = (tokens: number): string =>
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(tokens / 1000)}k`;
const dollars = (value: number): string => `$${value.toFixed(2)}`;

export function switchNotice(
    tokens: number,
    cost: Cost,
    retention: "short" | "long",
): { text: string; usd: number } | undefined {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const usd = (tokens * cacheWriteRate(cost, tokens, retention)) / 1_000_000;
    if (!(usd >= NOTICE_FLOOR_USD)) return;
    return {
        usd,
        text: `Switching model rewrites ~${tokensLabel(tokens)} tokens of cache: about ${dollars(usd)} (once). For one hard question, switch for that request only and switch back.`,
    };
}

/**
 * The cache is per model, so the first request after a switch writes the whole context again at the target's cache-write rate
 * (a session that stays on its model reads it at a fraction of that). One notice per switch, when that is real money and the
 * old cache was still alive: an expired cache is rewritten on the next request whichever model answers it.
 */
/** The parts of a session entry the cache check reads. Pi's own entry types are wider. */
interface SessionEntry {
    type?: string;
    kind?: string;
    timestamp?: string;
    message?: { role?: string; stopReason?: string; timestamp?: number };
}

export function registerSwitchNotice(pi: Pick<ExtensionAPI, "on">, options: { env?: NodeJS.ProcessEnv } = {}): void {
    const env = options.env ?? process.env;
    pi.on("model_select", (event, ctx) => {
        if (
            event.source === "restore" ||
            !event.previousModel ||
            !isOwnModel(event.model) ||
            ctx.mode === "print" ||
            ctx.mode === "json"
        )
            return;
        if (event.previousModel.provider === event.model.provider && event.previousModel.id === event.model.id) return;
        const tokens = ctx.getContextUsage?.()?.tokens;
        if (typeof tokens !== "number" || !event.model.cost) return;
        // Each side has its own route's retention: the old cache was written the way the old model's route writes it, the
        // new one is written the way the new model's route does. The Messages route sends 5-minute checkpoints only.
        // `promptCache` is a field this package adds to the models it registers (see catalog.ts).
        const promptCache = (event.previousModel as { promptCache?: PromptCache }).promptCache;
        const previous = retentionFor(event.previousModel, env);
        if (cacheExpired(ctx.sessionManager.getBranch() as readonly SessionEntry[], promptCache, previous)) return;
        const notice = switchNotice(tokens, event.model.cost, retentionFor(event.model, env));
        if (notice) ctx.ui.notify(notice.text, "info");
    });
}

/**
 * True only when the newest sign of cache activity is known to be older than the previous model's cache lifetime: the last
 * response (its timestamp is when the request started, which is when Bedrock refreshed the entry) or a Pi cache-warming refresh.
 */
function cacheExpired(
    entries: readonly SessionEntry[],
    promptCache: PromptCache | undefined,
    retention: "short" | "long",
    now = Date.now(),
): boolean {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        let at: number | undefined;
        if (entry?.type === "usage" && entry.kind === "cache_warm") at = Date.parse(entry.timestamp ?? "");
        else if (
            entry?.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message.stopReason !== "error" &&
            entry.message.stopReason !== "aborted"
        )
            at = entry.message.timestamp;
        if (at === undefined) continue;
        if (!Number.isFinite(at)) return false;
        return now - at > (promptCache?.[retention] ?? DEFAULT_TTL_SECONDS[retention]) * 1000;
    }
    return false;
}
