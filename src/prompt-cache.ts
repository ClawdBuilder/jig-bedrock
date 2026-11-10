export type PromptCache = { short: number; long?: number };

const REGION_PREFIX = /^(?:us|eu|apac|au|jp|in|global|us-gov)\./;
/**
 * Prompt-cache lifetimes in seconds, from Bedrock's "Supported models and explicit caching limits" table: Claude 4.5 and later
 * accept a 5-minute or 1-hour checkpoint, older Claude and Nova only the 5-minute one (a `ttl` on those fails validation).
 * Pi sends cache points only to Claude models; Nova relies on implicit caching and AWS caps its cache at 20K tokens, so for
 * Nova the lifetime is informative (footer, /session) and Pi's warming economics never select it. Models Bedrock does not
 * list stay undeclared, which keeps them out of Pi's cache warming.
 *
 * The Messages route has not shown the 1-hour checkpoint (Pi sends `ttl: "1h"` only when the model's compat allows it, and
 * catalog.ts does not), so on that route the model has the 5-minute lifetime only and nothing prices or warms an hour.
 */
export function promptCacheFor(
    foundationModelId: string,
    route: "messages" | "converse" = "converse",
): PromptCache | undefined {
    const id = foundationModelId.toLowerCase().replace(REGION_PREFIX, "");
    if (/^amazon\.nova-(?:2-)?(?:micro|lite|pro)(?![a-z0-9])/.test(id)) return { short: 300 };
    if (!id.startsWith("anthropic.claude")) return undefined;
    // anthropic.claude-sonnet-4-6, claude-haiku-4-5-20251001-v1:0, claude-opus-5; the 8-digit date is not a minor version.
    const version = /^anthropic\.claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
    if (!version) return { short: 300 };
    const major = Number(version[1]),
        minor = Number(version[2] ?? 0);
    return route === "converse" && (major > 4 || (major === 4 && minor >= 5))
        ? { short: 300, long: 3600 }
        : { short: 300 };
}

export type Retention = "short" | "long";
export type Cost = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: readonly { input: number; cacheWrite: number; inputTokensAbove: number }[];
};

/** `PI_CACHE_RETENTION=long` makes Pi's Bedrock stream write 1-hour cache points; anything else is the 5-minute default. */
export const retentionOf = (env: NodeJS.ProcessEnv = process.env): Retention =>
    env.PI_CACHE_RETENTION === "long" ? "long" : "short";

/** The retention a model's replies really get: Messages sends 5-minute checkpoints whatever `PI_CACHE_RETENTION` says. */
export const retentionFor = (model: { api?: string } | undefined, env: NodeJS.ProcessEnv = process.env): Retention =>
    model?.api === "anthropic-messages" ? "short" : retentionOf(env);

/**
 * Price per million tokens of writing the prompt cache for a request of `tokens` input tokens. The 5-minute write is the
 * model's cacheWrite rate; Pi bills a 1-hour write at twice the base input rate (calculateCost in pi-ai), in the pricing
 * tier the request size falls into.
 */
export function cacheWriteRate(cost: Cost, tokens: number, retention: Retention): number {
    let rates: { input: number; cacheWrite: number } = cost,
        above = -1;
    for (const tier of cost.tiers ?? [])
        if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > above) {
            rates = tier;
            above = tier.inputTokensAbove;
        }
    return retention === "long" ? rates.input * 2 : rates.cacheWrite;
}
