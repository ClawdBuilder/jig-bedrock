import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderAuth } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ProviderConfig,
    ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { isObject } from "./check.ts";
import { BEDROCK_PROVIDER_NAME, isOwnModel, JIG_BEDROCK } from "./identity.ts";
import { isAnthropicModel, noThinkingOff, rewriteThinkingOff, usesAdaptiveThinking } from "./messages.ts";
import { promptCacheFor } from "./prompt-cache.ts";

// biome-ignore lint/suspicious/noExplicitAny: Pi's model registry and session entries, checked field by field where they are used
type Json = any;

export { isOwnModel, JIG_BEDROCK } from "./identity.ts";

let activeRegistry: Record<string, Json> = {};
export function usePiRegistry(native: import("@earendil-works/pi-ai").Provider): void {
    const models = native.getModels();
    activeRegistry = Object.fromEntries(
        models
            .filter((m: Json) => m.provider === "amazon-bedrock" && typeof m.id === "string")
            .map((m: Json) => [m.id, m]),
    );
}

// Pi's own Anthropic registry entries for the same foundation model, so this package copies the mid-conversation
// compatibility facts Pi has already verified instead of guessing them again.
let anthropicRegistry: Record<string, Json> = {};
type AnthropicRegistryModule = {
    builtinProviders?: () => Array<{ id?: unknown; getModels?: () => readonly unknown[] }>;
};
/**
 * Pi's registry path is not a stable peer API. A Pi that lacks it (older or newer) must leave the fallback name
 * pattern in charge, never stop the provider: an import failure empties the registry.
 */
export async function usePiAnthropicRegistry(
    load: () => Promise<unknown> = () => import("@earendil-works/pi-ai/providers/all"),
): Promise<void> {
    try {
        const { builtinProviders } = (await load()) as AnthropicRegistryModule;
        if (typeof builtinProviders !== "function") throw new Error("no provider registry");
        const anthropic = builtinProviders().find((provider) => provider.id === "anthropic");
        const models = anthropic?.getModels?.() ?? [];
        anthropicRegistry = Object.fromEntries(
            models.filter((m): m is Json => isObject(m) && typeof m.id === "string").map((m: Json) => [m.id, m]),
        );
    } catch {
        anthropicRegistry = {};
    }
}

/** The Anthropic-route flags this package has verified on Bedrock; Pi's entry may carry more. */
const VERIFIED_ANTHROPIC_COMPAT = [
    "forceAdaptiveThinking",
    "supportsMidConvoEffort",
    "supportsMidConvoSystemMessages",
    "supportsMidConvoToolChanges",
] as const;

/** `anthropic.claude-sonnet-5-5` and `global.anthropic.claude-sonnet-5-5-v1:0` both name Pi's `claude-sonnet-5-5`. */
function piModelId(foundationModelId: string): string {
    return foundationModelId
        .replace(/^(?:[a-z0-9-]+\.)?anthropic\./, "")
        .replace(/-v\d+(?::\d+)?$/, "")
        .replace(/-\d{8}$/, "");
}

/**
 * Flags from Pi's Anthropic entry: copy a false value for any flag this package sets (temperature is the one that
 * matters today), and copy the verified flags only when Pi says true.
 */
function verifiedPiCompat(foundationModelId: string): Record<string, boolean> {
    const entry = anthropicRegistry[piModelId(foundationModelId)] as { compat?: Record<string, unknown> } | undefined;
    const compat: Record<string, boolean> = {};
    for (const key of Object.keys(MESSAGES_COMPAT)) {
        if (entry?.compat?.[key] === false) compat[key] = false;
    }
    for (const key of VERIFIED_ANTHROPIC_COMPAT) {
        if (entry?.compat?.[key] === true) compat[key] = true;
    }
    return compat;
}

// Pi 1.2 widened ProviderModelConfig to chat, image and classifier models; inference profiles are chat models.
type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;
export type BedrockModel = ChatModelConfig & {
    api: "anthropic-messages" | "bedrock-converse-stream";
    baseUrl: string;
    arn: string;
    foundationModelId: string;
    rateSource: "usage program" | "Pi registry";
    aliases: string[];
};

/**
 * What Pi's Anthropic Messages client is told about Bedrock's route, from Pi's own `getAnthropicCompat` names. The probe on the
 * test account showed native tool changes (the inline-tools beta and the deferred placeholder) working, so those stay on; long
 * cache retention and strict tool schemas are off because the route has not shown them, and the rest is the Anthropic API's
 * default, which the route mirrors. See the report for what was not tested.
 */
const MESSAGES_COMPAT = {
    supportsEagerToolInputStreaming: true,
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: true,
    supportsStrictTools: false,
    supportsTemperature: true,
    sendSessionAffinityHeaders: false,
    allowEmptySignature: false,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
} as const;
export type Profile = {
    arn: string;
    profile_name: string;
    foundation_model_id: string;
    region: string;
    kind?: "application" | "system";
};
export type Catalog = {
    schema: 1;
    mode?: "explicit" | "tag" | "system";
    team?: string;
    aws_profile: string;
    account_id: string;
    regions: string[];
    fetched_at: number;
    filter_hash?: string;
    warnings?: string[];
    profiles: Profile[];
    /** Explicit-list entries that could not be read; they do not stop the others. */
    errors?: { profile: string; message: string }[];
};
const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
const registryEntry = (id: string) =>
    activeRegistry[id] || activeRegistry[`us.${id}`] || activeRegistry[`global.${id}`];
const registryName = (name: string) => name.replace(/\s+\((?:US|Global)\)$/i, "");
const label = (s: unknown, n: number): s is string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: catalog labels never contain control characters
    typeof s === "string" && s.length > 0 && s.length <= n && !/[\x00-\x1f\x7f]/.test(s);
export function boundedRegular(file: string, max: number, privateMode = false): string | undefined {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const meta = fstatSync(fd);
        if (!meta.isFile() || meta.size > max || (privateMode && (meta.mode & 0o777) !== 0o600)) return;
        const buffer = Buffer.alloc(meta.size + 1);
        let total = 0;
        while (total < buffer.length) {
            const count = readSync(fd, buffer, total, buffer.length - total, null);
            if (!count) break;
            total += count;
        }
        return total <= max ? buffer.subarray(0, total).toString("utf8") : undefined;
    } finally {
        closeSync(fd);
    }
}
export function validArn(
    arn: string,
    region: string,
    account: string,
    kind: "application" | "system" | "any" = "application",
): boolean {
    const p = arn.split(":");
    // A profile id can contain a version colon (`...-v1:0`), so the resource is everything after the fifth colon.
    const resource = p.slice(5).join(":");
    const app = resource.startsWith("application-inference-profile/");
    const system = resource.startsWith("inference-profile/");
    return (
        p.length >= 6 &&
        p[0] === "arn" &&
        ["aws", "aws-cn", "aws-us-gov"].includes(p[1] ?? "") &&
        p[2] === "bedrock" &&
        p[3] === region &&
        (system ? p[4] === "" || p[4] === "aws" || p[4] === account : p[4] === account) &&
        (kind === "any" ? app || system : kind === "application" ? app : system) &&
        /^(?:application-inference-profile|inference-profile)\/[A-Za-z0-9.:-]{1,300}$/.test(resource)
    );
}
/** The discovery filter, hashed into the catalog so a changed tag or list is never reused. */
export function filterHash(expected: {
    mode?: "explicit" | "tag" | "system";
    tagKey?: string;
    tagValue?: string;
    activeTagKey?: string;
    activeTagValue?: string;
    profiles?: string[];
}): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                expected.mode ?? null,
                expected.tagKey ?? null,
                expected.tagValue ?? null,
                expected.activeTagKey ?? null,
                expected.activeTagValue ?? null,
                expected.profiles ?? null,
            ]),
        )
        .digest("hex");
}

export function readCatalog(
    file: string,
    expected: {
        mode?: "explicit" | "tag" | "system";
        team?: string;
        tagKey?: string;
        tagValue?: string;
        activeTagKey?: string;
        activeTagValue?: string;
        profiles?: string[];
        profile?: string;
        regions: string[];
    },
    now = Date.now(),
): Catalog | undefined {
    expected = { ...expected, regions: [...expected.regions].sort() };
    const directory = dirname(file);
    if (
        (expected.team !== undefined && !label(expected.team, 256)) ||
        (expected.profile !== undefined && !label(expected.profile, 128)) ||
        !expected.regions.length ||
        new Set(expected.regions).size !== expected.regions.length
    )
        return;
    try {
        for (let current = directory; dirname(current) !== current; current = dirname(current))
            if (lstatSync(current).isSymbolicLink()) return;
        const raw = boundedRegular(file, 1_048_576, true);
        if (!raw) return;
        const c = JSON.parse(raw) as Catalog;
        if (
            c.schema !== 1 ||
            c.team !== expected.team ||
            (c.mode === undefined
                ? expected.mode !== "tag" || c.filter_hash !== undefined
                : c.mode !== expected.mode || c.filter_hash !== filterHash(expected)) ||
            c.aws_profile !== (expected.profile ?? "") ||
            typeof c.account_id !== "string" ||
            !/^\d{12}$/.test(c.account_id) ||
            !Array.isArray(c.regions) ||
            c.regions.length !== expected.regions.length ||
            c.regions
                .slice()
                .sort()
                .some((r, i) => r !== expected.regions[i]) ||
            !Number.isSafeInteger(c.fetched_at) ||
            c.fetched_at < 0 ||
            c.fetched_at > now / 1000 ||
            !Array.isArray(c.profiles) ||
            c.profiles.length > 256
        )
            return;
        const seen = new Set<string>();
        for (const p of c.profiles) {
            if (
                !p ||
                !expected.regions.includes(p.region) ||
                !label(p.profile_name, 256) ||
                !label(p.foundation_model_id, 256) ||
                typeof p.arn !== "string" ||
                !validArn(p.arn, p.region, c.account_id, p.kind ?? "application") ||
                seen.has(p.arn)
            )
                return;
            seen.add(p.arn);
        }
        return c;
    } catch {
        return;
    }
}
function usageRates(dir: string): Map<string, ProviderModelConfig["cost"]> {
    try {
        const file = join(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(dir), "models.json");
        const raw = boundedRegular(file, 1_048_576);
        if (!raw) return new Map();
        const rows = JSON.parse(raw);
        if (!Array.isArray(rows)) return new Map();
        const rates = new Map<string, ProviderModelConfig["cost"]>();
        for (const row of rows) {
            const p = row?.pricing;
            if (
                label(row?.key, 128) &&
                p &&
                ["input", "output", "cache_read", "cache_write"].every((k) => Number.isFinite(p[k]) && p[k] >= 0)
            )
                rates.set(row.key, {
                    input: p.input,
                    output: p.output,
                    cacheRead: p.cache_read,
                    cacheWrite: p.cache_write,
                });
        }
        return rates;
    } catch {
        return new Map();
    }
}
/** Pi's level map for a model, plus a null off when the model cannot turn thinking off; a null entry hides that level. */
function thinkingLevelMap(
    base: ChatModelConfig["thinkingLevelMap"],
    foundationModelId: string,
): Pick<ChatModelConfig, "thinkingLevelMap"> | undefined {
    if (!noThinkingOff(foundationModelId)) return base === undefined ? undefined : { thinkingLevelMap: base };
    return { thinkingLevelMap: { ...(base ?? {}), off: null } };
}

/** System profiles first, by the geography of their id: the region's prefix, then global, then the rest. */
function orderedSystem(rows: Profile[], catalog: Catalog | undefined): Profile[] {
    const firstRegion = catalog?.regions?.[0] ?? "us-east-1";
    const first = /^us-gov-/.test(firstRegion)
        ? "us-gov"
        : /^ap-northeast-(?:1|3)$/.test(firstRegion)
          ? "jp"
          : /^ap-southeast-(?:2|4)$/.test(firstRegion)
            ? "au"
            : /^ap-/.test(firstRegion)
              ? "apac"
              : (firstRegion.split("-")[0] ?? "us");
    const geography = (p: Profile) => {
        const id = p.arn.slice(p.arn.lastIndexOf("/") + 1);
        const prefix = id.split(".")[0] ?? "";
        return prefix;
    };
    const order = catalog?.regions ?? [firstRegion];
    const rank = (p: Profile): number => {
        const prefix = geography(p);
        if (p.kind !== "system") return 999;
        if (prefix === first) return 0;
        if (prefix === "global") return 1;
        return 2 + Math.max(0, order.indexOf(p.region));
    };
    return rows
        .filter((p) => p.kind === "system")
        .sort((a, b) => rank(a) - rank(b) || (a.arn < b.arn ? -1 : a.arn > b.arn ? 1 : 0));
}

function orderedApplication(rows: Profile[]): Profile[] {
    const system = rows.filter((p) => p.kind === "system");
    const apps = rows.filter((p) => p.kind !== "system");
    return [...system, ...apps];
}

export function discoveredProfiles(
    catalog: Catalog | undefined,
    usageDir: string,
    api: "messages" | "converse" = "messages",
): { available: BedrockModel[]; unavailable: { profile: string; region: string; reason: string }[] } {
    if (!catalog) return { available: [], unavailable: [] };
    const rates = usageRates(usageDir),
        available: BedrockModel[] = [],
        unavailable = [];
    const grouped = new Map<string, Profile[]>();
    for (const p of catalog.profiles) {
        const r = registryEntry(p.foundation_model_id);
        if (
            !r ||
            !Number.isSafeInteger(r.contextWindow) ||
            !Number.isSafeInteger(r.maxTokens) ||
            typeof r.reasoning !== "boolean" ||
            !Array.isArray(r.input) ||
            !label(r.name, 256)
        ) {
            unavailable.push({
                profile: p.profile_name,
                region: p.region,
                reason: `Pi registry has no exact metadata for ${p.foundation_model_id}; update Pi to use this profile.`,
            });
            continue;
        }
        const key = slug(registryName(r.name));
        grouped.set(key, [...(grouped.get(key) || []), p]);
    }
    for (const [key, rows] of grouped) {
        const system = orderedSystem(rows, catalog);
        const preferred = system[0] ?? (rows.length === 1 ? rows[0] : undefined);
        for (const p of orderedApplication(rows)) {
            const r = registryEntry(p.foundation_model_id);
            const id = p === preferred ? key : `${key}--${p.region}--${p.arn.slice(p.arn.lastIndexOf("/") + 1)}`;
            const pricing = rates.get(key);
            const fallback =
                r.cost &&
                ["input", "output", "cacheRead", "cacheWrite"].every(
                    (k) => Number.isFinite(r.cost[k]) && r.cost[k] >= 0,
                )
                    ? r.cost
                    : undefined;
            if (!pricing && !fallback) {
                unavailable.push({
                    profile: p.profile_name,
                    region: p.region,
                    reason: `No valid pricing for ${p.foundation_model_id}; update Pi or usage program models.json.`,
                });
                continue;
            }
            const promptCache = promptCacheFor(p.foundation_model_id);
            // Only Claude profiles go on the Anthropic route; gpt, nova and the rest keep their own route.
            const messages = api === "messages" && p.kind !== "system" && isAnthropicModel(p.foundation_model_id);
            available.push({
                id,
                arn: p.arn,
                foundationModelId: p.foundation_model_id,
                aliases: [],
                name: registryName(r.name) + (p === preferred ? "" : ` (${p.region}, ${p.profile_name})`),
                api: messages ? "anthropic-messages" : "bedrock-converse-stream",
                baseUrl: messages
                    ? `https://bedrock-runtime.${p.region}.amazonaws.com/anthropic`
                    : `https://bedrock-runtime.${p.region}.amazonaws.com`,
                ...(messages
                    ? {
                          compat: {
                              ...MESSAGES_COMPAT,
                              // The mid-conversation binding/effort/tool facts come from Pi's own Anthropic entry.
                              ...verifiedPiCompat(p.foundation_model_id),
                              // Claude 5.5 refuses budget thinking; older Claude models still need it.
                              ...(usesAdaptiveThinking(p.foundation_model_id) ? { forceAdaptiveThinking: true } : {}),
                          },
                      }
                    : {}),
                reasoning: r.reasoning,
                input: [...r.input],
                contextWindow: r.contextWindow,
                maxTokens: r.maxTokens,
                cost: pricing || { ...fallback },
                rateSource: pricing ? "usage program" : "Pi registry",
                ...(promptCache ? { promptCache } : {}),
                ...(thinkingLevelMap(r.thinkingLevelMap, p.foundation_model_id) ?? {}),
            });
        }
    }
    return { available, unavailable };
}
export function updateModels(
    current: BedrockModel[],
    updated: BedrockModel[],
): { changed: boolean; added: number; removed: number } {
    const before = new Set(current.map((m) => `${m.id}|${m.arn}`));
    const after = new Set(updated.map((m) => `${m.id}|${m.arn}`));
    const changed = JSON.stringify(current) !== JSON.stringify(updated);
    if (changed) current.splice(0, current.length, ...updated);
    return {
        changed,
        added: [...after].filter((x) => !before.has(x)).length,
        removed: [...before].filter((x) => !after.has(x)).length,
    };
}
export function resolveSelection(models: readonly BedrockModel[], selection: string): BedrockModel | undefined {
    const id = selection.replace(/^(?:amazon-bedrock|jig-bedrock)\//, "");
    // A session saved under Pi's built-in provider names the configured profile by its ARN.
    const matches = models.filter((m) => m.id === id || m.arn === id || m.aliases.includes(id));
    return matches.length === 1 ? matches[0] : undefined;
}
type Stream = NonNullable<ProviderConfig["streamSimple"]>;
/** What the provider needs at request time: the current profile (or none) and its own auth, never Pi's Bedrock auth. */
export interface BedrockIdentity {
    profile: () => string | undefined;
    auth: ProviderAuth;
}
export interface BedrockStreams {
    /** Pi's Bedrock Converse stream, from its own `amazon-bedrock` provider. */
    converse: Stream;
    /** Pi's Anthropic Messages stream, for Bedrock's `/anthropic` route. */
    messages?: Stream;
}
export function bedrockStream(
    models: readonly BedrockModel[],
    streams: BedrockStreams,
    load: () => Catalog | undefined,
    profile: () => string | undefined,
    signedFetch?: typeof globalThis.fetch,
): Stream {
    const approved = [...models];
    return (model, context, options) => {
        const physical = approved.find((m) => m.id === model.id);
        if (
            model.provider !== JIG_BEDROCK ||
            !physical ||
            !load()?.profiles.some(
                (p) => p.arn === physical.arn && p.foundation_model_id === physical.foundationModelId,
            )
        )
            throw new Error("That Bedrock profile is not in your model list; choose an available model with /model.");
        const current = profile();
        // A key or bearer token is never this provider's auth, and a different profile is never borrowed silently.
        if (
            options?.apiKey ||
            (options as Json)?.bearerToken ||
            (current !== undefined &&
                (((options as Json)?.profile && (options as Json).profile !== current) ||
                    (options?.env?.AWS_PROFILE && options.env.AWS_PROFILE !== current)))
        )
            throw new Error(
                "That Bedrock authentication scope is not supported; choose the configured profile with /model.",
            );
        const scoped = {
            ...options,
            ...(current === undefined ? {} : { profile: current }),
            env: {
                ...options?.env,
                ...(current === undefined ? {} : { AWS_PROFILE: current }),
                AWS_BEARER_TOKEN_BEDROCK: "",
                AWS_BEDROCK_SKIP_AUTH: "0",
            },
        };
        // Pi records the model it is given but sends that model's id on the wire. A logical model carries this
        // package's provider and short id (for /model and resume); onPayload swaps in the ARN for the request.
        const logical = { ...model, ...physical, provider: JIG_BEDROCK, id: physical.id };
        if (physical.api === "anthropic-messages") {
            const messages = streams.messages;
            if (!messages || !signedFetch) throw new Error("The Bedrock Messages route is not available; reload Pi.");
            const previous = (options as Json)?.onPayload as
                | ((payload: unknown, selected: unknown) => unknown)
                | undefined;
            return messages({ ...logical, api: "anthropic-messages" }, context, {
                ...scoped,
                // Pi's Anthropic client wants some key before it builds a request. It never reaches Bedrock: the signed
                // fetch removes both this and any Authorization header before signing.
                apiKey: "bedrock-sigv4",
                fetch: signedFetch,
                // The wire needs the ARN; the recorded provider and model stay this package's short id. Sonnet 5.5 also
                // refuses Pi's thinking-off shape; every other payload is left exactly as it came.
                onPayload: async (payload: unknown, selected: unknown) => {
                    const next = previous === undefined ? payload : await previous(payload, selected);
                    const value = { ...((next ?? payload) as Record<string, unknown>), model: physical.arn };
                    return rewriteThinkingOff(value, physical.foundationModelId);
                },
            } as typeof options);
        }
        const previous = (options as Json)?.onPayload as ((payload: unknown, selected: unknown) => unknown) | undefined;
        return streams.converse({ ...logical, api: "bedrock-converse-stream" }, context, {
            ...scoped,
            onPayload: async (payload: unknown, selected: unknown) => {
                const next = previous === undefined ? payload : await previous(payload, selected);
                return { ...((next ?? payload) as Record<string, unknown>), modelId: physical.arn };
            },
        });
    };
}
export async function registerBedrockProvider(
    pi: Pick<ExtensionAPI, "registerProvider">,
    _agentDir: string,
    native?: import("@earendil-works/pi-ai").Provider,
    models: BedrockModel[] = [],
    load: () => Catalog | undefined = () => undefined,
    identity: BedrockIdentity = { profile: () => undefined, auth: {} },
    messages?: { stream: Stream; streamSimple: Stream },
    signedFetch?: typeof globalThis.fetch,
): Promise<BedrockModel[]> {
    if (!native) {
        const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
        native = builtinProviders().find((provider) => provider.id === "amazon-bedrock");
        if (!native) throw new Error("Pi Bedrock provider unavailable; update Pi and reload.");
    }
    const picker = models.map(
        ({ arn: _arn, aliases: _aliases, foundationModelId: _foundation, rateSource: _rate, ...m }) => ({
            ...m,
            type: "chat" as const,
            provider: JIG_BEDROCK,
        }),
    );
    pi.registerProvider({
        id: JIG_BEDROCK,
        name: BEDROCK_PROVIDER_NAME,
        auth: identity.auth,
        getModels: () => picker,
        getAllModels: () => picker,
        stream: bedrockStream(
            models,
            { converse: native.stream as Stream, ...(messages ? { messages: messages.stream } : {}) },
            load,
            identity.profile,
            signedFetch,
        ) as typeof native.stream,
        streamSimple: bedrockStream(
            models,
            {
                converse: native.streamSimple,
                ...(messages ? { messages: messages.streamSimple } : {}),
            },
            load,
            identity.profile,
            signedFetch,
        ),
    });
    return models;
}
export function registerBedrockSelectionGuard(
    pi: Pick<ExtensionAPI, "on" | "setModel">,
    models: BedrockModel[],
    options: {
        agentDir?: string;
        explicitSelection?: () => boolean;
        /** While a background discovery is running, the provider has a better "still loading" notice; warn on input. */
        deferStartupWarning?: () => boolean;
        /** Discovery timed out or the network is slow: say so instead of calling the saved model unavailable. */
        discoverySlow?: () => boolean;
    } = {},
): { blockUntilChoice(): void } {
    let unresolvedSavedSelection = false;
    const unavailableWarning =
        "Saved Bedrock model is unavailable or ambiguous for your profiles; choose a model with /model before sending a request.";
    const slowWarning =
        "AWS discovery is slow; Bedrock models are not loaded yet. Try again in a moment or run /bedrock-refresh.";
    const warning = () => (options.discoverySlow?.() === true ? slowWarning : unavailableWarning);
    // 0.2.x recorded the built-in provider with the profile ARN; only that shape is ours to migrate. A plain id is Pi's
    // built-in model and must be left alone.
    const oldRecorded = (model: { provider?: string; id?: string } | undefined) =>
        model?.provider === "amazon-bedrock" && typeof model.id === "string" && model.id.startsWith("arn:");
    const ours = (model: { provider?: string; id?: string } | undefined) => isOwnModel(model) || oldRecorded(model);
    const unsupported = (ctx: ExtensionContext) =>
        unresolvedSavedSelection ||
        (ours(ctx.model) && (ctx.model?.provider !== JIG_BEDROCK || !models.some((m) => m.id === ctx.model?.id)));
    const restore = async (event: { type?: string; reason?: string }, ctx: ExtensionContext) => {
        // Pi 1.2 reports a session switch as session_start with reason new, resume or fork.
        const switched =
            event.type === "session_start" &&
            (event.reason === "new" || event.reason === "resume" || event.reason === "fork");
        let warned = false;
        const selected = [...ctx.sessionManager.getBranch()]
            .reverse()
            .find(
                (e: Json) => e.type === "model_change" || (e.type === "message" && e.message?.role === "assistant"),
            ) as Json;
        let provider = selected?.type === "model_change" ? selected.provider : selected?.message?.provider;
        let id = selected?.type === "model_change" ? selected.modelId : selected?.message?.model;
        if (!selected && !options.explicitSelection?.()) {
            try {
                const settings = JSON.parse(
                    readFileSync(
                        join(
                            options.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"),
                            "settings.json",
                        ),
                        "utf8",
                    ),
                );
                provider = settings.defaultProvider;
                id = settings.defaultModel;
            } catch {
                /* No saved default. */
            }
        }
        if ((!options.explicitSelection?.() || switched) && ours({ provider, id: id || "" })) {
            const match = resolveSelection(models, id || ""),
                target = match && ctx.modelRegistry.find(JIG_BEDROCK, match.id);
            if (!target) {
                unresolvedSavedSelection = true;
                if (options.deferStartupWarning?.() !== true) {
                    ctx.ui.notify(warning(), "warning");
                    warned = true;
                }
            } else if (ctx.model?.provider !== target.provider || ctx.model.id !== target.id) {
                if (!(await pi.setModel(target))) {
                    unresolvedSavedSelection = true;
                    ctx.ui.notify(warning(), "warning");
                    warned = true;
                } else unresolvedSavedSelection = false;
            }
        }
        if (!warned && options.deferStartupWarning?.() !== true && unsupported(ctx))
            ctx.ui.notify(warning(), "warning");
    };
    pi.on("session_start", restore);
    pi.on("model_select", (event, ctx) => {
        if (event.source === "set" || event.source === "cycle") unresolvedSavedSelection = false;
        if (unsupported(ctx)) ctx.ui.notify(warning(), "warning");
    });
    pi.on("input", (event, ctx) => {
        if (!unsupported(ctx)) return { action: "continue" };
        if (ctx.mode === "tui" && event.source === "interactive" && !event.streamingBehavior)
            ctx.ui.setEditorText(event.text);
        ctx.ui.notify(warning(), "warning");
        return { action: "handled" };
    });
    return {
        blockUntilChoice: () => {
            unresolvedSavedSelection = true;
        },
    };
}
