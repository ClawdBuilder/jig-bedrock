// The Bedrock model provider: your inference profiles as Pi models, AWS SSO recovery, a monthly spend figure and
// the commands around them. Its settings are bedrock.json and the JIG_BEDROCK_* environment (see config.ts).
//
// The factory registers and reads settings, and no more: AWS and the browser are touched in `session_start`, in the
// background, or by a command the user types.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getResources } from "./aws-api.ts";
import { writeAwsConfig } from "./aws-config-write.ts";
import type { CatalogSource, Status } from "./aws-discovery.ts";
import { category, discoveryHelp, partialDiscovery } from "./aws-discovery.ts";
import {
    awsConfigFile,
    checkedRecovery,
    isSsoProfile,
    keysAdviceNext,
    profileProblem,
    ssoSignInTarget,
    type VerifyResult,
    verifyAwsProfile,
} from "./aws-profile.ts";
import type { BedrockModel } from "./catalog.ts";
import {
    bedrockStream,
    registerBedrockProvider,
    registerBedrockSelectionGuard,
    updateModels,
    usePiAnthropicRegistry,
    usePiRegistry,
} from "./catalog.ts";
import { isObject } from "./check.ts";
import { type BedrockCommand, registerBedrockCommands, registerBrokenCommands } from "./commands.ts";
import type { ConfigResult, ResolvedConfig } from "./config.ts";
import { loadConfig, PRESET_FIELDS, presetNamePattern, TOP_LEVEL_PRESET } from "./config.ts";
import { loadCredentialProvider } from "./credential-provider.ts";
import { createDebugLog, debugEnabled, withDebugLog, withDebugRecover } from "./debug-log.ts";
import { checkLocalDependencies } from "./doctor.ts";
import { isOwnModel, isOwnProvider, JIG_BEDROCK, presetOf, providerIdOf, providerNameOf } from "./identity.ts";
import type { RecoveryOptions } from "./login.ts";
import { createRecovery } from "./login.ts";
import { askDiscoverySettings, askProfile, type LoginFlowOptions, runLoginFlow } from "./login-flow.ts";
import { markers } from "./markers.ts";
import { PresetRuntime, type PresetRuntimeHost } from "./preset-runtime.ts";
import type { ListProfiles, ProfileChoice } from "./profile.ts";
import { createListProfiles, loginOutcomeMessage, memoizedList, missingProfileNotice } from "./profile.ts";
import { clearRefusals, refusedModels } from "./refusals.ts";
import {
    readSettingsDocument,
    saveDiscoverySettings,
    saveProfileSetting,
    writeSettingsDocument,
} from "./settings-write.ts";
import type { AwsCredentials } from "./sigv4.ts";
import type { SpendTracker } from "./spend.ts";
import type { Recover, RecoveredBedrock } from "./sso.ts";
import { noticeFor, registerBedrockSsoRecovery, shareRecovery } from "./sso.ts";
import type { SsoState } from "./sso-check.ts";
import { checkSso, systemSsoDeps } from "./sso-check.ts";
import { registerSignInAtStart } from "./start-sign-in.ts";
import { registerSwitchNotice } from "./switch-cost.ts";

type Json = Record<string, unknown>;
/** A prompt in the guided preset setup was cancelled; nothing has been written. */
class PresetSetupCancelled extends Error {}
const routeOf = (model: BedrockModel): string => (model.api === "anthropic-messages" ? "Messages" : "Converse");
/** The nearest name within two edits, for a misspelt preset. */
function _nearName(value: string, names: readonly string[]): string | undefined {
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const name of names) {
        const row = Array.from({ length: value.length + 1 }, (_, i) => [i, ...Array(name.length).fill(0)]);
        for (let j = 1; j <= name.length; j++) (row[0] as number[])[j] = j;
        for (let i = 1; i <= value.length; i++)
            for (let j = 1; j <= name.length; j++)
                (row[i] as number[])[j] = Math.min(
                    (row[i - 1]?.[j] ?? 0) + 1,
                    (row[i]?.[j - 1] ?? 0) + 1,
                    (row[i - 1]?.[j - 1] ?? 0) + (value[i - 1] === name[j - 1] ? 0 : 1),
                );
        const distance = row[value.length]?.[name.length] ?? Infinity;
        if (distance < bestDistance) [best, bestDistance] = [name, distance];
    }
    return bestDistance <= 2 ? best : undefined;
}

export type { CatalogSource, Recover, ResolvedConfig };

export interface BedrockOptions {
    catalog?: CatalogSource;
    /** The settings, already resolved. Without them they are read from bedrock.json and the environment. */
    config?: ResolvedConfig;
    ssoRecover?: Recover;
    /** The parts of the default sign-in a test replaces: the program that starts the login, its lock, its environment, WSL. */
    login?: Omit<RecoveryOptions, "say">;
    /** Whether the profile's SSO session is still good, for the sign-in at start. Without it the AWS SDK in Pi's install answers. */
    ssoCheck?: (profile: string, signal: AbortSignal) => Promise<SsoState>;
    /** `aws configure list-profiles`, for tests. */
    listProfiles?: ListProfiles;
    /** The same listing with /login's longer timeout, for tests. */
    loginListProfiles?: ListProfiles;
    /** The local AWS CLI check /login runs before its first question. */
    check?: typeof checkLocalDependencies;
    /** The STS check /login runs; without it `aws sts get-caller-identity`. */
    verifyProfile?: (profile: string | undefined, signal: AbortSignal) => Promise<VerifyResult>;
    /** The SSO sign-in /login runs; without it the shared recovery. */
    signInProfile?: (profile: string, signal: AbortSignal) => Promise<void>;
    /** A test can replace the spend record and command. */
    spend?: SpendTracker;
    selection?: { agentDir?: string; explicitSelection?: () => boolean };
    transformModels?: (models: BedrockModel[]) => BedrockModel[];
    backgroundRefresh?: boolean;
    /** How long /login waits for its first refresh before saying the models are still loading. */
    loginRefreshWaitMs?: number;
    preserveNativeAuth?: boolean;
    /** The AWS credentials of the Messages route; the SDK's default provider for the profile unless a test supplies them. */
    credentials?: () => Promise<AwsCredentials>;
    /** The fetch signed requests go through, so a test can watch them. */
    fetch?: typeof globalThis.fetch;
    /** A test can replace the SDK credential chain for discovery. */
    discoveryCredentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
    env?: NodeJS.ProcessEnv;
}

export interface BedrockHandle {
    models: BedrockModel[];
    refresh: (force?: boolean) => Promise<Status>;
    failed: boolean;
}

/** Pi's agent folder, from PI_CODING_AGENT_DIR or HOME, shared by settings and notices. */
export function agentFolder(env: NodeJS.ProcessEnv = process.env): string {
    return env.PI_CODING_AGENT_DIR === undefined || env.PI_CODING_AGENT_DIR === ""
        ? path.join(env.HOME ?? homedir(), ".pi", "agent")
        : env.PI_CODING_AGENT_DIR;
}

/** The user's own bedrock settings file; `bedrock` or the file itself may hold the keys. */
function userSettingsFile(env: NodeJS.ProcessEnv): {
    settings?: Record<string, unknown>;
    problem?: string;
} {
    const file = path.join(agentFolder(env), "bedrock.json");
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        return { problem: `${file} could not be read; check its permissions.` };
    }
    try {
        const raw = JSON.parse(text) as unknown;
        const value = isObject(raw) && isObject(raw.bedrock) ? raw.bedrock : raw;
        return isObject(value) ? { settings: value } : { problem: `${file} does not hold a JSON object.` };
    } catch {
        return { problem: `${file} is not valid JSON; fix it or remove it.` };
    }
}

function userSettings(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
    return userSettingsFile(env).settings;
}

/** The 0.2.x file this release only reads to offer a copy; it is plain JSON, never imported. */
function oldSettings(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
    try {
        const file = path.join(agentFolder(env), "jig.json");
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const value = isObject(raw) && isObject(raw.bedrock) ? raw.bedrock : undefined;
        return value;
    } catch {
        return undefined;
    }
}

/** `team` was the 0.2.x short form: the migration writes the generic keys and the Active rule. */
function migratedSettings(source: Record<string, unknown>): Record<string, unknown> {
    const out = { ...source };
    delete out.usageDir;
    if (typeof out.team === "string" && out.team !== "") {
        const team = out.team;
        delete out.team;
        out.tagKey = "Team";
        out.tagValue = team;
        out.activeTagKey = "Active";
        out.activeTagValue = "true";
    }
    return out;
}

function registerMigration(
    pi: Pick<ExtensionAPI, "on">,
    env: NodeJS.ProcessEnv,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
    const destination = path.join(agentFolder(env), "bedrock.json");
    const notice = (): void => {
        if (existsSync(destination)) return;
        if (oldSettings(env) === undefined) return;
        // The only jig.json wording in the package: a one-release migration notice.
        pi.on("session_start", (_event, context) =>
            context.ui.notify(
                "Your Bedrock settings are in jig.json. This version reads bedrock.json only. Run /bedrock migrate to copy them; this stays until 0.6.0.",
                "warning",
            ),
        );
    };
    notice();
    return async (args: string, context: ExtensionCommandContext): Promise<void> => {
        if (args.trim() !== "migrate") {
            context.ui.notify("Usage: /bedrock migrate", "warning");
            return;
        }
        const source = oldSettings(env);
        if (source === undefined) {
            context.ui.notify("No jig.json Bedrock settings to copy.", "warning");
            return;
        }
        try {
            mkdirSync(path.dirname(destination), { recursive: true });
            const text = `${JSON.stringify(migratedSettings(source), null, 4)}\n`;
            writeFileSync(destination, text, { mode: 0o600, flag: "wx" });
            chmodSync(destination, 0o600);
            context.ui.notify(`Copied Bedrock settings to ${destination}. Run /reload to use them.`, "info");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
                context.ui.notify(`${destination} already exists; it was not overwritten.`, "warning");
            else context.ui.notify(`Could not write ${destination}; check permissions.`, "warning");
        }
    };
}

export function createBedrockProvider(
    options: BedrockOptions = {},
): (pi: ExtensionAPI) => Promise<BedrockHandle | undefined> {
    return async (pi) => {
        const resolved: ConfigResult = options.config
            ? { config: options.config }
            : loadConfig({
                  raw: userSettings(options.env ?? process.env),
                  env: options.env ?? process.env,
              });
        const config = resolved.config;
        const migration = registerMigration(pi, options.env ?? process.env);
        let bedrockCommand: BedrockCommand | undefined;
        let bedrockCompletions: ((prefix: string) => Array<{ value: string; label: string }>) | undefined;
        // The command being run, so every source it reads (settings, spend, catalog, models) follows the runtime that
        // command acts on; the model in use decides that runtime.
        let commandContext: ExtensionCommandContext | undefined;
        // Preset providers whose model was in use when the preset was removed: Pi keeps them until the next model change.
        const unregisterLater = new Set<string>();
        pi.registerCommand("bedrock", {
            description: "Bedrock status, models, spend and settings",
            getArgumentCompletions: (prefix) => (bedrockCompletions ? bedrockCompletions(prefix) : null),
            handler: async (args, context) => {
                commandContext = context;
                try {
                    if (bedrockCommand) await bedrockCommand(args, context);
                    else await migration(args, context);
                } finally {
                    commandContext = undefined;
                }
            },
        });
        let guard: ReturnType<typeof registerBedrockSelectionGuard>;
        const settingsFile = userSettingsFile(options.env ?? process.env).problem;
        const unknownSettings = resolved.unknown ?? [];
        if (settingsFile !== undefined || unknownSettings.length > 0)
            pi.on("session_start", (_event, context) => {
                if (settingsFile !== undefined) context.ui.notify(settingsFile, "warning");
                if (unknownSettings.length > 0)
                    context.ui.notify(
                        `Bedrock ignores unknown setting${unknownSettings.length === 1 ? "" : "s"} ${unknownSettings.join(", ")} in ${path.join(agentFolder(options.env), "bedrock.json")}; see docs/settings.md.`,
                        "warning",
                    );
            });
        if (!config) {
            const file = path.join(agentFolder(options.env), "bedrock.json");
            const where = `Fix ${file}, then /reload.`;
            pi.on("session_start", (_event, ctx) =>
                ctx.ui.notify(`Bedrock provider disabled: ${resolved.error} ${where}`, "warning"),
            );
            bedrockCommand = registerBrokenCommands(pi, {
                file,
                error: resolved.error,
                env: options.env ?? process.env,
                migrate: migration,
            });
            return undefined;
        }
        // Where the profile comes from, resolved once a session starts: the setting, /login's credential, the AWS
        // environment, then the default profile. Pi's credential is read through its registry, never from auth.json.
        const profileEnv = options.env ?? (options.config === undefined ? process.env : {});
        const m = markers(profileEnv);
        const loginListProfiles = memoizedList(options.loginListProfiles ?? createListProfiles(profileEnv));
        const debug = createDebugLog({ enabled: debugEnabled(options.env ?? process.env, config), env: options.env });
        const lifetime = new AbortController();
        const backgroundRefresh = options.backgroundRefresh !== false;
        let ctx: ExtensionContext | undefined;
        let native: Provider | undefined;
        let messages: RecoveredBedrock["messages"];
        let failed = false;
        let disposed = false;
        let afterProfileLogin:
            | ((
                  runtime: PresetRuntime,
                  profile: string | undefined,
                  interaction: ProviderAuthInteraction,
                  signal: AbortSignal,
              ) => Promise<void>)
            | undefined;
        const firstRunNotice = (context: ExtensionContext): void => {
            if (!context.hasUI) return;
            if (context.model !== undefined && context.model.provider !== "unknown" && !isOwnModel(context.model))
                return;
            const marker = path.join(agentFolder(options.env), ".bedrock-first-run");
            if (existsSync(marker)) return;
            try {
                writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
            } catch {
                return;
            }
            const line = "Bedrock: run /login, choose Amazon Bedrock (jig-bedrock), then /model.";
            if (context.hasUI) context.ui.notify(line, "info");
            else process.stdout.write(`${line}\n`);
        };
        // 0.7.0's shape: the plain provider is always the top-level settings, and every preset is its own provider.
        // The `preset` setting only chooses a new session's model (§6); JIG_BEDROCK_PRESET narrows the list to plain +
        // that preset, and it never changes the plain provider's settings. `allPresetModels: false` keeps 0.6.3's
        // shape: one plain provider carrying `preset`/env's settings and discovering only its own models.
        const allPresetModels = config.allPresetModels !== false;
        const envPreset = profileEnv.JIG_BEDROCK_PRESET;
        const presetCatalogNames = config.presetNames ?? [];
        const enabledPresets = !allPresetModels
            ? []
            : envPreset !== undefined && envPreset !== ""
              ? presetCatalogNames.includes(envPreset)
                  ? [envPreset]
                  : []
              : presetCatalogNames;
        // The same loader preset management uses; the top level ignores JIG_BEDROCK_PRESET, which names a preset.
        const reloadForPreset = (
            name: string | undefined,
            _context?: ExtensionCommandContext,
            ignoreEnvPreset = false,
        ): ConfigResult => {
            const raw = userSettings(profileEnv) ?? {};
            const env = { ...profileEnv };
            if (ignoreEnvPreset) delete env.JIG_BEDROCK_PRESET;
            else if (name !== undefined && env.JIG_BEDROCK_PRESET !== undefined) env.JIG_BEDROCK_PRESET = name;
            const scopedRaw = { ...raw };
            if (name === undefined) delete scopedRaw.preset;
            else scopedRaw.preset = name;
            return loadConfig({
                raw: scopedRaw,
                env,
                agentDir: config.agentDir,
                presetOverride: name,
            });
        };
        const runtimeConfigs: Array<{ preset: string | undefined; config: ResolvedConfig }> = [];
        if (!allPresetModels) runtimeConfigs.push({ preset: config.preset, config });
        else {
            // A resolved top-level config (options.config) is the top level; one carrying `preset`/env is not: the
            // plain provider always keeps the top-level settings in this shape.
            const top = config.preset === undefined ? config : reloadForPreset(undefined, undefined, true).config;
            if (top !== undefined) runtimeConfigs.push({ preset: undefined, config: top });
            for (const preset of enabledPresets) {
                const presetConfig = reloadForPreset(preset).config;
                if (presetConfig !== undefined) runtimeConfigs.push({ preset, config: presetConfig });
            }
        }
        if (runtimeConfigs.length === 0) return undefined;
        // The one registration path: every runtime, at start and on every model change, lands here with its own
        // refusal handler, catalog, models, signed fetch and provider id.
        const register = async (runtime: PresetRuntime): Promise<void> => {
            if (!native) return;
            await registerBedrockProvider(
                pi,
                runtime.config.agentDir || "",
                native,
                runtime.models,
                runtime.catalog.load,
                runtime.identity(),
                (model, message) => runtime.refusalMessage(model, message),
                messages,
                runtime.signedFetch,
                (options) => runtime.refreshForModelSelector(options.force, options.signal),
                runtime.providerId,
                runtime.displayName,
            );
        };
        const runtimeFor = new Map<string | undefined, PresetRuntime>();
        const host: PresetRuntimeHost = {
            pi,
            env: profileEnv,
            options,
            debug,
            context: () => ctx,
            streams: () => (native === undefined ? undefined : { provider: native, messages }),
            guard: () => guard,
            agentDir: () => config.agentDir ?? agentFolder(profileEnv),
            signal: () => lifetime.signal,
            disposed: () => disposed,
            firstRunNotice,
            registerModels: (runtime) => register(runtime),
            // One catalog file per runtime, plus a spare for the scope a pending setting change just left (design §7).
            catalogKeep: () => Math.min(32, runtimeFor.size + 1),
            login: {
                listed: loginListProfiles,
                guided: (runtime, interaction) => guided(runtime, interaction),
                after: (runtime, profile, interaction, signal) =>
                    afterProfileLogin?.(runtime, profile, interaction, signal) ?? Promise.resolve(),
            },
        };
        for (const entry of runtimeConfigs)
            runtimeFor.set(
                entry.preset,
                new PresetRuntime({
                    host,
                    config: entry.config,
                    providerId: providerIdOf(entry.preset),
                    displayName: providerNameOf(entry.preset),
                }),
            );
        const runtimes = [...runtimeFor.values()];
        const primary = runtimeFor.get(undefined) ?? runtimes[0];
        if (primary === undefined) return undefined;
        const topLevel = runtimeFor.get(undefined) ?? primary;
        /** The runtime registered under each Pi provider id. */
        const runtimeByProvider = new Map<string, PresetRuntime>();
        for (const runtime of runtimes) runtimeByProvider.set(runtime.providerId, runtime);
        /** Build one more runtime for a preset, at /bedrock preset add/remove and a refresh that lands after an add. */
        const adoptRuntime = (preset: string | undefined, presetConfig: ResolvedConfig): PresetRuntime => {
            const runtime = new PresetRuntime({
                host,
                config: presetConfig,
                providerId: providerIdOf(preset),
                displayName: providerNameOf(preset),
            });
            runtimeFor.set(preset, runtime);
            runtimeByProvider.set(runtime.providerId, runtime);
            runtimes.push(runtime);
            return runtime;
        };
        /** Forget a runtime whose preset is gone; the caller unregisters its provider. */
        const forgetRuntime = (runtime: PresetRuntime): void => {
            runtimeFor.delete(runtime.config.preset);
            runtimeByProvider.delete(runtime.providerId);
            const at = runtimes.indexOf(runtime);
            if (at >= 0) runtimes.splice(at, 1);
        };
        /** The registered runtime a provider id names, if any (the plain id is the top level). */
        const runtimeForProviderId = (providerId: string | undefined): PresetRuntime | undefined =>
            providerId === undefined ? undefined : runtimeByProvider.get(providerId);
        /** Pi's saved default, which decides the runtime until a model is chosen (design §4). */
        const savedDefaultProvider = (): string | undefined => {
            try {
                const settings = JSON.parse(
                    readFileSync(path.join(config.agentDir ?? agentFolder(profileEnv), "settings.json"), "utf8"),
                ) as { defaultProvider?: unknown };
                return typeof settings.defaultProvider === "string" && settings.defaultProvider !== ""
                    ? settings.defaultProvider
                    : undefined;
            } catch {
                return undefined;
            }
        };
        /**
         * Which preset the footer, the spend record and /bedrock act on: the model in use when it is ours, else the
         * runtime of Pi's saved default when that is one of ours, else the top-level settings (design §4).
         */
        const currentRuntime = (context?: { model?: { provider?: string } }): PresetRuntime =>
            runtimeForProviderId(context?.model?.provider) ?? runtimeForProviderId(savedDefaultProvider()) ?? topLevel;
        /** The runtime the command being handled acts on; outside a command, the session's model decides. */
        const commandRuntime = (): PresetRuntime => currentRuntime(commandContext);
        // The runtime 0.6.3 would use is registered last, so it is also the newest registration.
        const orderedRuntimes = [...runtimes.filter((runtime) => runtime !== primary), primary];
        const models = primary.models;
        const profiles = primary.profiles;
        const currentProfile = (): string | undefined => primary.currentProfile();
        const readModels = () => primary.readModels();
        // The tag listing /login's second-tag offer reads; the guided preset setup uses the same one.
        const loginTagMatches: NonNullable<LoginFlowOptions["tagMatches"]> = async (
            profile,
            regions,
            key,
            value,
            signal,
        ) => {
            // One credential resolution for this lookup, from the profile chosen in the flow, then signed HTTPS calls.
            let credentials: AwsCredentials | undefined;
            const load = async (): Promise<AwsCredentials> => {
                if (credentials !== undefined) return credentials;
                if (options.discoveryCredentials !== undefined) credentials = await options.discoveryCredentials();
                else {
                    const provider = await loadCredentialProvider();
                    credentials = (await provider(profile === undefined ? {} : { profile })()) as AwsCredentials;
                }
                return credentials;
            };
            const all: Array<Array<{ Key: string; Value: string }>> = [];
            for (const region of regions) {
                const result = await getResources(
                    region,
                    { tagFilters: [{ Key: key, Values: [value] }] },
                    {
                        credentials: await load(),
                        timeoutMs: 20_000,
                        signal,
                        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                    },
                );
                for (const row of result.ResourceTagMappingList ?? [])
                    if (Array.isArray(row.Tags))
                        all.push(
                            row.Tags.filter(
                                (tag): tag is { Key: string; Value: string } =>
                                    typeof tag === "object" &&
                                    tag !== null &&
                                    typeof (tag as { Key?: unknown }).Key === "string" &&
                                    typeof (tag as { Value?: unknown }).Value === "string",
                            ),
                        );
            }
            return all;
        };
        // /login's guided choice: the AWS CLI is the only place a secret is entered, and the profile is verified before
        // the credential is stored. A fresh listing is used after the access-key/role guidance.
        const guided = async (runtime: PresetRuntime, interaction: ProviderAuthInteraction) => {
            const health = await (options.check ?? checkLocalDependencies)({
                signal: interaction.signal,
                env: profileEnv,
                timeout: 15_000,
            });
            if (health.aws.status !== "ready") {
                const message =
                    'jig-bedrock needs AWS CLI v2 for sign-in and listing models. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html — or choose "Use a Bedrock API key with Pi\'s own provider".';
                throw new Error(
                    "AWS CLI v2 is required: install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, then run /login again.",
                );
            }
            let saveFailure: string | undefined;
            const credential = await runLoginFlow(interaction, {
                listProfiles: loginListProfiles,
                refreshProfiles: () => createListProfiles(profileEnv)(),
                isSso: (profile) => !("problem" in ssoSignInTarget(profile, profileEnv)),
                verify: (profile, signal) =>
                    options.verifyProfile?.(profile, signal) ?? verifyAwsProfile(profile, { env: profileEnv, signal }),
                signIn: (profile, signal) =>
                    options.signInProfile?.(profile, signal) ?? recoveryForLogin(profile, signal, "manual"),
                saveDiscovery: (settings) => {
                    const result = saveDiscoverySettings(profileEnv, settings, runtime.config.preset);
                    if (!result.written)
                        saveFailure = `Bedrock settings were not saved: ${result.error ?? result.file}`;
                    return result;
                },
                regions: runtime.config.regions,
                configFile: awsConfigFile(profileEnv),
                writeConfig: (sections) => writeAwsConfig(profileEnv, sections),
                reportNote: (message) => setTimeout(() => ctx?.ui.notify(message, "warning"), 0),
                tagMatches: loginTagMatches,
            });
            if (saveFailure !== undefined) setTimeout(() => ctx?.ui.notify(saveFailure!, "warning"), 0);
            return credential;
        };
        // A profile that can be known without starting a program: the setting, /login's credential, AWS_PROFILE,
        // AWS_DEFAULT_PROFILE, or the default section in the AWS files. This lets each runtime's cache, made for that
        // profile, load at the factory, before session_start, so --model and --list-models see the models.
        const preScanProfiles = async (): Promise<void> => {
            if (runtimes.every((each) => each.config.profile !== undefined)) return;
            const names = await createListProfiles(profileEnv)();
            const fromEnv = profileEnv.AWS_PROFILE ?? profileEnv.AWS_DEFAULT_PROFILE;
            for (const each of runtimes) {
                if (each.config.profile !== undefined) continue;
                const profile =
                    each.storedProfile() ??
                    (fromEnv !== undefined && fromEnv !== ""
                        ? fromEnv
                        : names?.includes("default")
                          ? "default"
                          : undefined);
                if (profile !== undefined) each.config.profile = profile;
            }
        };
        await preScanProfiles();
        registerSwitchNotice(pi, { env: options.env });
        // A repair the sign-in makes for WSL is told in one line, the way the notices of a waiting request are.
        const say = (line: string): void => {
            if (ctx) noticeFor(ctx)(line, "info");
        };
        const recovery = withDebugRecover(
            options.ssoRecover ?? createRecovery(config, { ...options.login, say }),
            debug,
        );
        // The same preflight guards both the command and the automatic repair: the profile must exist (when a person is
        // waiting) and be an SSO profile, or no `aws sso login` child starts.
        const recoveryForLogin =
            options.ssoRecover ?? checkedRecovery(recovery, { manualList: loginListProfiles, env: profileEnv });
        try {
            const recovered = await registerBedrockSsoRecovery(
                pi,
                recoveryForLogin,
                currentProfile,
                (profile, signal) => profileProblem(profile, { list: loginListProfiles, env: profileEnv, signal }),
            );
            const logged = withDebugLog(recovered, debug);
            native = logged.provider;
            messages = logged.messages;
            await usePiAnthropicRegistry();
            usePiRegistry(native);
            for (const runtime of runtimes) runtime.loadCachedModels();
            for (const runtime of orderedRuntimes) await register(runtime);
        } catch {
            failed = true;
        }
        const refresh = (force = true, notifyFailure = false, quiet = false): Promise<Status> =>
            primary.refresh(force, notifyFailure, quiet);
        /** Reload the file for one runtime's scope: its preset, or the top level even when JIG_BEDROCK_PRESET is set. */
        const reloadSettings = (runtime: PresetRuntime = primary): ConfigResult =>
            runtime.config.preset === undefined
                ? reloadForPreset(undefined, undefined, true)
                : reloadForPreset(runtime.config.preset);
        const replaceConfig = (next: ResolvedConfig): void => primary.replaceConfig(next);
        const applyResolved = (next: ConfigResult): boolean => primary.applyResolved(next);
        afterProfileLogin = async (runtime, profile, interaction, signal) => {
            runtime.storedAuthSeen = true;
            if (profile === undefined) runtime.config.profile = undefined;
            else runtime.config.profile = profile;
            runtime.profiles.stored = profile;
            runtime.lastChoice = profile === undefined ? { ambient: true } : { profile, source: "login", exists: true };
            interaction.notify({ type: "progress", message: "Loading Bedrock models…" });
            {
                const savedProfile = saveProfileSetting(profileEnv, profile, runtime.config.preset);
                if (!savedProfile.ok)
                    interaction.notify({
                        type: "info",
                        message: `The AWS profile could not be saved: ${savedProfile.error ?? "unknown error"}.`,
                    });
            }
            const loaded = reloadSettings(runtime);
            if (!runtime.applyResolved(loaded)) {
                interaction.notify({
                    type: "info",
                    message: `Bedrock settings could not be loaded: ${loaded.error ?? "unknown error"}. Not refreshing the models.`,
                });
                return;
            }
            if (profile !== undefined && ctx) {
                const resolved = await runtime.resolveProfile(ctx);
                if (resolved.profile !== undefined && resolved.profile !== profile)
                    interaction.notify({
                        type: "info",
                        message: `profile ${resolved.profile} overrides the profile chosen at /login.`,
                    });
            }
            runtime.settingsBaseline = runtime.models.length;
            const updated = runtime.readModels().available;
            if (updateModels(runtime.models, updated).changed && native) {
                await register(runtime);
            }
            runtime.settingsChanged = true;
            let settled = true;
            const timeout = new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    settled = false;
                    resolve();
                }, options.loginRefreshWaitMs ?? 20_000);
                timer.unref();
            });
            const outcome = await Promise.race([
                runtime
                    .refresh(true, true)
                    .then((status) => status)
                    .catch(() => "unavailable" as const),
                timeout.then(() => undefined),
            ]);
            if (signal.aborted) {
                interaction.notify({
                    type: "info",
                    message: "Saved profile and discovery; models are loading. /bedrock settings to change.",
                });
                return;
            }
            const failedAdvice =
                outcome !== undefined && outcome !== "ok"
                    ? `${runtime.catalog.failure?.() ?? "Bedrock could not load models."} Next: ${discoveryHelp(outcome, runtime.config.mode)}`
                    : undefined;
            const message = loginOutcomeMessage(
                runtime.models.length,
                settled,
                failedAdvice ?? runtime.catalog.load()?.warnings?.join(" "),
            );
            interaction.notify({ type: "info", message });
            const presetMessage =
                runtime.config.preset === undefined ? undefined : `Saved to preset ${runtime.config.preset}.`;
            if (presetMessage !== undefined) interaction.notify({ type: "info", message: presetMessage });
            // The login dialog closes as soon as the credential is returned; defer the chat line until after that, so
            // the dialog's teardown cannot clear the only lasting explanation of what happened.
            const context = ctx;
            // Pi captures its model when the login dialog opens, so a first /login can end with no model chosen. Pick
            // the first registered one for this session; a model that was already selected is left alone.
            let selectedLine: string | undefined;
            if (
                context !== undefined &&
                (context.model === undefined || context.model.provider === "unknown") &&
                runtime.models.length > 0
            ) {
                const first = runtime.models[0];
                const target =
                    first === undefined ? undefined : context.modelRegistry?.find?.(runtime.providerId, first.id);
                if (target !== undefined) {
                    try {
                        if (await pi.setModel(target)) {
                            selectedLine = `Selected ${first.id} for this session. To keep it for every start: /model, select it, Ctrl+S.`;
                        }
                    } catch {
                        // The selection is a convenience; a failed one never fails the login.
                    }
                }
            }
            if (context) {
                const shown = presetMessage === undefined ? message : `${message} ${presetMessage}`;
                const timer = setTimeout(() => {
                    context.ui.notify(shown, "info");
                    if (selectedLine !== undefined) context.ui.notify(selectedLine, "info");
                }, 300);
                timer.unref();
            }
        };
        const presetModeName = (mode: ResolvedConfig["mode"]): string =>
            mode === "explicit" ? "listed" : mode === "tag" ? "by tag" : "AWS-defined";
        const presetList = () => {
            const settings = userSettings(profileEnv);
            const raw = settings?.presets;
            const top = topLevel.config;
            const topProfile = top.profile ?? (typeof settings?.profile === "string" ? settings.profile : undefined);
            const activeRuntime = commandRuntime();
            // The labels a person reads must be the ones the preset would really run: the effective settings merge the
            // preset over the top level, exactly as switching does.
            const modeLabel = (mode: ResolvedConfig["mode"], body: Record<string, unknown>): string => {
                if (mode !== undefined) return presetModeName(mode);
                if (body.discovery === "tag") return "by tag";
                if (body.discovery === "list") return "listed";
                if (body.discovery === "aws-defined") return "AWS-defined";
                return body.profiles !== undefined
                    ? "listed"
                    : body.tagKey !== undefined || body.team !== undefined
                      ? "by tag"
                      : "AWS-defined";
            };
            return [
                {
                    name: TOP_LEVEL_PRESET,
                    label: "Top-level settings",
                    profile: topProfile,
                    mode: presetModeName(top.mode),
                    active: activeRuntime === topLevel,
                    source: "top-level",
                },
                ...Object.keys(isObject(raw) ? raw : {})
                    .sort()
                    .filter((name) => runtimeFor.has(name))
                    .map((name) => {
                        const body = isObject(raw) && isObject(raw[name]) ? (raw[name] as Record<string, unknown>) : {};
                        const runtime = runtimeFor.get(name);
                        const effective = runtime?.config ?? reloadForPreset(name).config;
                        const profile =
                            effective?.profile ?? (typeof body.profile === "string" ? body.profile : undefined);
                        const active = runtime !== undefined && activeRuntime === runtime;
                        return {
                            name,
                            profile,
                            mode: modeLabel(effective?.mode, body),
                            active,
                            // A preset is active because its model is in use; the file's word only says where it came from.
                            source: active
                                ? config.preset === name
                                    ? config.presetSource
                                    : "model in use"
                                : undefined,
                        };
                    }),
            ];
        };
        const saveSettings = (document: Record<string, unknown>): string | undefined => {
            const saved = writeSettingsDocument(profileEnv, document);
            return saved.ok ? undefined : saved.error;
        };
        /** This session's last model for a provider, from Pi's own branch. */
        const rememberedModel = (context: ExtensionContext, providerId: string): string | undefined => {
            const branch = (context.sessionManager?.getBranch?.() ?? []) as unknown as Json[];
            for (let i = branch.length - 1; i >= 0; i--) {
                const entry = branch[i];
                if (
                    entry?.type === "model_change" &&
                    entry.provider === providerId &&
                    typeof entry.modelId === "string"
                )
                    return entry.modelId;
                const message = entry?.type === "message" ? (entry.message as Json | undefined) : undefined;
                if (
                    message?.role === "assistant" &&
                    message.provider === providerId &&
                    typeof message.model === "string"
                )
                    return message.model;
            }
            return undefined;
        };
        /** Pi's saved default model, when it belongs to this provider. */
        const savedModelFor = (providerId: string): string | undefined => {
            try {
                const settings = JSON.parse(
                    readFileSync(path.join(config.agentDir ?? agentFolder(profileEnv), "settings.json"), "utf8"),
                ) as { defaultProvider?: unknown; defaultModel?: unknown };
                return settings.defaultProvider === providerId && typeof settings.defaultModel === "string"
                    ? settings.defaultModel
                    : undefined;
            } catch {
                return undefined;
            }
        };
        /** What /bedrock use picks: this session's last for it, else the saved default if it is that provider, else its first. */
        const chooseModel = (runtime: PresetRuntime, context: ExtensionContext): BedrockModel | undefined => {
            for (const id of [rememberedModel(context, runtime.providerId), savedModelFor(runtime.providerId)]) {
                if (id === undefined) continue;
                const found = runtime.models.find((model) => model.id === id);
                if (found !== undefined) return found;
            }
            return runtime.models[0];
        };
        /** Select one runtime's model through Pi, so the footer, budget and scope follow it (design §6). */
        const selectModel = async (runtime: PresetRuntime, context: ExtensionContext): Promise<boolean> => {
            const model = chooseModel(runtime, context);
            if (model === undefined) return false;
            const target = context.modelRegistry?.find?.(runtime.providerId, model.id);
            if (target === undefined) {
                context.ui.notify(
                    `Bedrock: Pi has no entry for ${model.id}; run /bedrock refresh, then /bedrock use again.`,
                    "warning",
                );
                return false;
            }
            try {
                return (await pi.setModel(target)) !== false;
            } catch {
                return false;
            }
        };
        const presetName = (runtime: PresetRuntime): string =>
            runtime.config.preset === undefined ? "the top-level settings" : `preset ${runtime.config.preset}`;
        /** Write (or clear) the `preset` setting that decides a new session's model; JIG_BEDROCK_PRESET wins over it. */
        const writePresetSetting = (name: string | undefined): string | undefined => {
            if (profileEnv.JIG_BEDROCK_PRESET !== undefined) return undefined;
            const document = readSettingsDocument(profileEnv);
            if ("error" in document) return document.error;
            if (name === undefined) delete document.target.preset;
            else document.target.preset = name;
            return saveSettings(document.document);
        };
        const announceActivated = (runtime: PresetRuntime, name: string, context: ExtensionCommandContext): void => {
            const toTop = name === TOP_LEVEL_PRESET;
            const activated = toTop
                ? `Top-level settings are active: ${runtime.config.profile ?? "no AWS profile"} · ${presetModeName(runtime.config.mode)}`
                : `Preset ${name} is active: ${runtime.config.profile ?? "no AWS profile"} · ${presetModeName(runtime.config.mode)}`;
            context.ui.notify(
                profileEnv.JIG_BEDROCK_PRESET === undefined || toTop ? activated : `${activated} (for this Pi only)`,
                "info",
            );
        };
        const usePreset = async (
            name: string,
            context: ExtensionCommandContext,
            switchOptions: { newlySaved?: boolean } = {},
        ): Promise<void> => {
            const toTop = name === TOP_LEVEL_PRESET;
            const runtime = toTop ? topLevel : runtimeFor.get(name);
            if (runtime === undefined) {
                const known = [...runtimeFor.keys()].filter((preset): preset is string => preset !== undefined).sort();
                emitPreset(context, [
                    `${m.fail} Unknown preset ${name}.`,
                    `Known presets: ${known.join(", ") || "none"}.`,
                ]);
                return;
            }
            if (runtime.models.length === 0) {
                // Its models are still arriving: say so, start the refresh, and change nothing else for a plain `use`.
                context.ui.notify(toTop ? "Loading the top-level models…" : `Loading ${name}'s models…`, "info");
                if (switchOptions.newlySaved !== true) {
                    void runtime.refresh(false).catch(() => {});
                    return;
                }
                // A preset just saved: it is the choice for new sessions, and its model is selected when the list lands.
                const error = writePresetSetting(toTop ? undefined : name);
                if (error !== undefined) {
                    emitPreset(context, [`${m.fail} ${error}`]);
                    return;
                }
                announceActivated(runtime, name, context);
                void runtime
                    .refresh(true)
                    .then(async (status) => {
                        if (status === "ok" && runtime.models.length > 0) await selectModel(runtime, context);
                    })
                    .catch(() => {});
                return;
            }
            if (!(await selectModel(runtime, context))) {
                emitPreset(context, [`${m.fail} Could not select a model for ${presetName(runtime)}.`]);
                return;
            }
            const error = writePresetSetting(toTop ? undefined : name);
            if (error !== undefined) {
                emitPreset(context, [`${m.fail} ${error}`]);
                return;
            }
            announceActivated(runtime, name, context);
        };
        /** The command UI as the prompt interface /login uses, so the guided preset setup shares login's prompts. */
        const presetInteraction = (context: ExtensionCommandContext): ProviderAuthInteraction => {
            const signal = context.signal ?? new AbortController().signal;
            return {
                signal,
                prompt: async (prompt) => {
                    if (prompt.type === "select") {
                        const answer = await context.ui.select(
                            prompt.message,
                            prompt.options.map((option) => option.label),
                            { signal },
                        );
                        if (answer === undefined) throw new PresetSetupCancelled();
                        return (
                            prompt.options.find((option) => option.label === answer || option.id === answer)?.id ??
                            answer
                        );
                    }
                    const answer = await context.ui.input(prompt.message, prompt.placeholder, { signal });
                    if (answer === undefined) throw new PresetSetupCancelled();
                    return answer;
                },
                notify: (event) => {
                    if (event.type === "info" || event.type === "progress") context.ui.notify(event.message, "info");
                },
            };
        };
        const newPreset = async (context: ExtensionCommandContext): Promise<void> => {
            const interaction = presetInteraction(context);
            try {
                const document = readSettingsDocument(profileEnv);
                if ("error" in document) {
                    context.ui.notify(document.error, "warning");
                    return;
                }
                const presets = isObject(document.target.presets) ? { ...document.target.presets } : {};
                let name = "";
                for (;;) {
                    const answer = await interaction.prompt({
                        type: "text",
                        message: "New preset name · letters, digits, . _ - · up to 40",
                        placeholder: "work",
                    });
                    const value = answer.trim();
                    if (value === "") return;
                    if (!presetNamePattern.test(value)) {
                        interaction.notify({
                            type: "info",
                            message: `${value} is not a preset name: a letter or digit, then up to 39 letters, digits, dots, underscores or hyphens.`,
                        });
                        continue;
                    }
                    if (value === TOP_LEVEL_PRESET) {
                        interaction.notify({
                            type: "info",
                            message: `${value} is reserved for the top-level settings; choose another name.`,
                        });
                        continue;
                    }
                    if (Object.hasOwn(presets, value)) {
                        interaction.notify({
                            type: "info",
                            message: `Preset ${value} already exists; choose another name.`,
                        });
                        continue;
                    }
                    name = value;
                    break;
                }
                const listed = await loginListProfiles(interaction.signal);
                const profile = await askProfile(interaction, listed);
                const settings = await askDiscoverySettings(
                    interaction,
                    { regions: config.regions, tagMatches: loginTagMatches },
                    profile,
                );
                const body: Record<string, unknown> = {
                    profile,
                    discovery: settings.mode === "explicit" ? "list" : settings.mode === "tag" ? "tag" : "aws-defined",
                    regions: settings.regions,
                };
                if (settings.mode === "tag") {
                    body.tagKey = settings.tagKey;
                    body.tagValue = settings.tagValue;
                    if (settings.activeTagKey !== undefined) body.activeTagKey = settings.activeTagKey;
                    if (settings.activeTagValue !== undefined) body.activeTagValue = settings.activeTagValue;
                } else if (settings.mode === "explicit") {
                    body.profiles = settings.profiles;
                }
                presets[name] = body;
                document.target.presets = presets;
                const candidate = loadConfig({
                    raw: { ...document.target, preset: name },
                    env: profileEnv,
                    agentDir: config.agentDir,
                    presetOverride: name,
                });
                if (!candidate.config) {
                    context.ui.notify(`The preset was not saved: ${candidate.error ?? "unknown error"}.`, "warning");
                    return;
                }
                const error = saveSettings(document.document);
                if (error !== undefined) {
                    context.ui.notify(`The preset was not saved: ${error}.`, "warning");
                    return;
                }
                if (!(await activateSavedPreset(name, context))) return;
            } catch (error) {
                if (error instanceof PresetSetupCancelled) return;
                context.ui.notify(
                    `The preset was not created: ${error instanceof Error ? error.message : String(error)}.`,
                    "warning",
                );
            }
        };
        const addPreset = async (name: string, context: ExtensionCommandContext): Promise<void> => {
            if (!presetNamePattern.test(name)) {
                emitPreset(context, [`${m.fail} ${name} is not a preset name.`]);
                return;
            }
            const document = readSettingsDocument(profileEnv);
            if ("error" in document) {
                emitPreset(context, [`${m.fail} ${document.error}`]);
                return;
            }
            const presets = isObject(document.target.presets) ? { ...document.target.presets } : {};
            if (presets[name] !== undefined) {
                emitPreset(context, [`${m.fail} Preset ${name} already exists.`]);
                return;
            }
            const body: Record<string, unknown> = {};
            const source = commandRuntime();
            const sourcePreset = source.config.preset;
            const sourceBody =
                isObject(document.target.presets) &&
                sourcePreset !== undefined &&
                isObject(document.target.presets[sourcePreset])
                    ? (document.target.presets[sourcePreset] as Record<string, unknown>)
                    : {};
            const envNames: Record<string, string> = {
                profile: "JIG_BEDROCK_PROFILE",
                regions: "JIG_BEDROCK_REGIONS",
                tagKey: "JIG_BEDROCK_TAG_KEY",
                tagValue: "JIG_BEDROCK_TAG_VALUE",
                team: "JIG_BEDROCK_TEAM",
            };
            for (const key of PRESET_FIELDS) {
                const explicit =
                    Object.hasOwn(document.target, key) ||
                    Object.hasOwn(sourceBody, key) ||
                    (envNames[key] !== undefined && profileEnv[envNames[key] as string] !== undefined);
                if (!explicit) continue;
                const value = (source.config as unknown as Record<string, unknown>)[key];
                if (value !== undefined) body[key] = value;
            }
            presets[name] = body;
            document.target.presets = presets;
            if (profileEnv.JIG_BEDROCK_PRESET === undefined) document.target.preset = name;
            const error = saveSettings(document.document);
            if (error !== undefined) {
                emitPreset(context, [`${m.fail} ${error}`]);
                return;
            }
            if (!(await activateSavedPreset(name, context))) return;
            currentRuntime(context).spend.updateFooter(context);
            emitPreset(context, [
                `${m.ok} Preset ${name} saved and active; models reloaded.`,
                `The footer now shows ${name}'s spend, including this month's spend from before presets.`,
            ]);
        };
        const removePreset = async (name: string, context: ExtensionCommandContext): Promise<void> => {
            const document = readSettingsDocument(profileEnv);
            if ("error" in document) {
                emitPreset(context, [`${m.fail} ${document.error}`]);
                return;
            }
            const presets = isObject(document.target.presets) ? { ...document.target.presets } : {};
            if (presets[name] === undefined) {
                emitPreset(context, [`${m.fail} Preset ${name} does not exist.`]);
                return;
            }
            delete presets[name];
            document.target.presets = presets;
            if (document.target.preset === name) delete document.target.preset;
            const error = saveSettings(document.document);
            if (error !== undefined) {
                emitPreset(context, [`${m.fail} ${error}`]);
                return;
            }
            const runtime = runtimeFor.get(name);
            if (runtime !== undefined) {
                if (currentRuntime(context) === runtime) {
                    // Its model is in use: keep the provider until the person picks another, and stop input meanwhile.
                    guard?.blockUntilChoice();
                    unregisterLater.add(runtime.providerId);
                    context.ui.notify(
                        `Bedrock: preset ${name} was removed while its model is in use. Choose another with /model.`,
                        "warning",
                    );
                } else if (allPresetModels) {
                    unregisterRuntime(runtime);
                } else {
                    // The 0.6.3 shape's one plain provider carried the preset; it falls back to the top-level settings.
                    const next = reloadForPreset(undefined, undefined, true);
                    if (next.config) primary.replaceConfig(next.config);
                    primary.rebuildCatalog();
                    const updated = readModels().available;
                    updateModels(models, updated);
                    if (native) await register(primary);
                }
            }
            emitPreset(context, [
                `${m.ok} Preset ${name} removed.`,
                currentRuntime(context) === topLevel
                    ? "Top-level settings are active."
                    : `Preset ${currentRuntime(context).config.preset ?? "?"} is active.`,
            ]);
        };
        /**
         * A preset that was just saved: build its runtime from the file, register it, and select its model. It reads
         * the same cached catalog, so `preset add` needs no discovery (design §6).
         */
        const activateSavedPreset = async (name: string, context: ExtensionCommandContext): Promise<boolean> => {
            const next = reloadForPreset(name);
            if (!next.config) {
                emitPreset(context, [`${m.fail} ${next.error}`]);
                return false;
            }
            const runtime = adoptRuntime(name, next.config);
            runtime.loadCachedModels();
            if (!native) return false;
            await register(runtime);
            await usePreset(name, context, { newlySaved: true });
            return true;
        };
        const unregisterRuntime = (runtime: PresetRuntime): void => {
            try {
                pi.unregisterProvider(runtime.providerId);
            } catch {
                // A Pi too old to unregister still forgets the runtime; its models leave /model at the next reload.
            }
            forgetRuntime(runtime);
        };
        const emitPreset = (context: ExtensionCommandContext, rows: string[]): void => {
            const text = ["Bedrock presets", ...rows].join("\n");
            if (context.hasUI) context.ui.notify(text, "info");
            else process.stdout.write(`${text}\n`);
        };
        // /bedrock login renews an SSO profile or a role over an SSO source_profile, and nothing else, so its next step
        // is offered only where it can work. A keys profile or a role over keys is checked with the AWS CLI instead.
        const signInNext = (name: string): string =>
            "target" in ssoSignInTarget(name, profileEnv)
                ? "Next: /bedrock login"
                : keysAdviceNext(name, "/bedrock doctor.");
        const commands = registerBedrockCommands(pi, {
            // Read per command: the provider rebinds these to the runtime the model in use names (design §4).
            get config() {
                return commandRuntime().config;
            },
            get spend() {
                return commandRuntime().spend;
            },
            catalog: {
                load: () => commandRuntime().catalog.load(),
                refresh: (force = false) => commandRuntime().catalog.refresh(force),
                failure: () => commandRuntime().catalog.failure?.(),
            },
            models: () => commandRuntime().models,
            profiles,
            stored: () => profiles.stored,
            listProfiles: loginListProfiles,
            env: profileEnv,
            migrate: migration,
            refresh: () => commandRuntime().refresh(true, true, true),
            failure: () => commandRuntime().catalog.failure?.(),
            discoveryStatus: () => commandRuntime().catalog.status?.(),
            discoveryMode: () => commandRuntime().config.mode,
            signedIn: () => commandRuntime().signInConfirmed,
            storedAuthLost: () => commandRuntime().storedAuthLost(),
            login: async () => {
                const runtime = commandRuntime();
                const profile = runtime.lastChoice.profile ?? runtime.config.profile;
                if (!profile) throw new Error("No AWS profile is chosen. Run /login first.");
                await recoveryForLogin(profile, undefined, "manual");
                await runtime.refresh(true, true);
            },
            unavailable: () => commandRuntime().readModels().unavailable,
            lastChoice: () => commandRuntime().lastChoice,
            loading: () => commandRuntime().loading(),
            presetNames: () => commandRuntime().config.presetNames ?? [],
            presetList: () => presetList(),
            activePreset: () => ({ name: config.preset, source: config.presetSource }),
            usePreset: (name, context) => usePreset(name, context),
            presetNew: (context) => newPreset(context),
            presetAdd: (name, context) => addPreset(name, context),
            presetRemove: (name, context) => removePreset(name, context),
            apply: async (refreshModels = false) => {
                const runtime = commandRuntime();
                const next = reloadSettings(runtime);
                if (!runtime.applyResolved(next)) return;
                if (runtime.config.profile !== undefined && options.listProfiles !== undefined) {
                    const listed = await options.listProfiles(undefined);
                    runtime.lastChoice = {
                        profile: runtime.config.profile,
                        source: runtime.config.profileSource === "env" ? "env" : "setting",
                        exists: listed === undefined ? true : listed.includes(runtime.config.profile),
                    };
                }
                // A save that changes no discovery setting (a budget, a model route) starts no refresh; marking it would
                // make the next unrelated refresh report this save's stale count instead of what changed.
                if (refreshModels) {
                    runtime.settingsChanged = true;
                    runtime.settingsBaseline = runtime.models.length;
                }
                const context = commandContext ?? ctx;
                if (context) runtime.spend.updateFooter(context);
                const updated = runtime.readModels().available;
                if (updateModels(runtime.models, updated).changed && native) await register(runtime);
            },
            doctorAws: async (signal) => {
                const runtime = commandRuntime();
                const runtimeConfig = runtime.config;
                const choice = runtime.lastChoice.profile ?? runtimeConfig.profile;
                const rows: Array<{
                    ok: boolean;
                    warn?: boolean;
                    text: string;
                    check: "sign-in" | "models" | "one-profile" | "save";
                    next?: string;
                }> = [];
                if (!choice)
                    return [
                        {
                            ok: false,
                            text: "Sign-in: no profile chosen",
                            check: "sign-in",
                            next: "Next: /login, choose Amazon Bedrock (jig-bedrock)",
                        },
                    ];
                const problem =
                    (isSsoProfile(choice, profileEnv) ?? false)
                        ? await profileProblem(choice, { list: loginListProfiles, env: profileEnv, signal })
                        : undefined;
                if (problem !== undefined)
                    rows.push({
                        ok: false,
                        text: problem,
                        check: "sign-in",
                        next: "Next: /login, choose Amazon Bedrock (jig-bedrock)",
                    });
                else {
                    try {
                        const check = await (
                            options.verifyProfile ??
                            ((profile, sig) => verifyAwsProfile(profile, { env: profileEnv, signal: sig }))
                        )(choice, signal);
                        if (check.ok) runtime.markSignedIn();
                        const expired =
                            !check.ok &&
                            (isSsoProfile(choice, profileEnv) ?? false) &&
                            category(check.message ?? "") === "sso_expired";
                        rows.push({
                            ok: check.ok,
                            check: "sign-in",
                            ...(check.ok ? {} : { next: signInNext(choice) }),
                            text: check.ok
                                ? "Sign-in: AWS answered"
                                : expired
                                  ? "Sign-in: sign-in expired"
                                  : (check.message ?? "Sign-in: did not answer"),
                        });
                    } catch {
                        rows.push({
                            ok: false,
                            text: "Sign-in: did not answer",
                            check: "sign-in",
                            next: signInNext(choice),
                        });
                    }
                }
                const status = await runtime.refresh(true, false, true);
                const reason = runtime.catalog.failure?.();
                const catalogNow = runtime.catalog.load();
                const partial = status === "ok" ? partialDiscovery(catalogNow) : undefined;
                const errors = catalogNow?.errors ?? [];
                const failedRegions = new Set(
                    (catalogNow?.warnings ?? [])
                        .filter((warning) => /^[a-z0-9-]+ did not answer:/.test(warning))
                        .map((warning) => warning.slice(0, warning.indexOf(" "))),
                );
                const answered = runtimeConfig.regions.filter((region) => !failedRegions.has(region));
                rows.push({
                    ok: errors.length === 0 && status === "ok" && runtime.models.length > 0,
                    check: "models",
                    ...(errors.length === 0 || partial === undefined
                        ? {}
                        : {
                              warn: true,
                              next: "Next: check the failed profile in /bedrock settings, then /bedrock refresh.",
                          }),
                    text:
                        status !== "ok"
                            ? `Models: ${reason ?? "could not list"}`
                            : runtime.models.length === 0
                              ? runtimeConfig.mode === "tag"
                                  ? `Models: no inference profiles with tag ${runtimeConfig.tagKey}=${runtimeConfig.tagValue} in ${runtimeConfig.regions.join(", ")}`
                                  : `Models: no Claude models in ${runtimeConfig.regions.join(", ")}`
                              : errors.length > 0 && partial !== undefined
                                ? `Models: ${partial.line}. ${partial.errors}`
                                : `Models: ${runtime.models.length} found in ${answered.join(", ")} (${runtimeConfig.mode === "tag" ? "tag" : runtimeConfig.mode === "explicit" ? "explicit list" : "AWS-defined"})`,
                });
                const save = runtime.catalog.saveFailure?.();
                if (save !== undefined)
                    rows.push({
                        ok: false,
                        warn: true,
                        check: "save",
                        next: "Next: check the folder's permissions, then /bedrock refresh.",
                        text: save.message,
                    });
                return rows;
            },
            clearRefusals: () => {
                const runtime = commandRuntime();
                return clearRefusals(profileEnv, runtime.config.profile, runtime.refusalAccount);
            },
            refused: () => {
                const runtime = commandRuntime();
                return refusedModels(profileEnv, runtime.config.profile, runtime.refusalAccount);
            },
            doctorCall: async (signal) => {
                const runtime = commandRuntime();
                const selected = runtime.models.find((model) => model.id === (commandContext ?? ctx)?.model?.id);
                if (!selected || !native) throw new Error("No selected Bedrock model to call.");
                const started = performance.now();
                const stream = bedrockStream(
                    [selected],
                    { converse: native.stream, ...(messages ? { messages: messages.stream } : {}) },
                    runtime.catalog.load,
                    () => runtime.currentProfile(),
                    runtime.signedFetch,
                    (model, message) => runtime.refusalMessage(model, message),
                    runtime.providerId,
                );
                let usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
                let failure: string | undefined;
                for await (const event of stream(
                    { ...selected, provider: runtime.providerId },
                    {
                        messages: [{ role: "user", content: "Reply with one word: ready", timestamp: Date.now() }],
                    } as never,
                    { signal },
                )) {
                    if (event.type === "done") usage = event.message.usage;
                    if (event.type === "error") failure = event.error?.errorMessage ?? "the tiny call failed";
                }
                if (failure !== undefined) throw new Error(failure);
                runtime.markSignedIn();
                return {
                    route: routeOf(selected),
                    ms: Math.round(performance.now() - started),
                    cacheRead: usage.cacheRead ?? 0,
                    cacheWrite: usage.cacheWrite ?? 0,
                };
            },
        });
        bedrockCommand = commands.bedrock;
        bedrockCompletions = commands.completions;
        const resolveProfile = (context: ExtensionContext): Promise<ProfileChoice> => primary.resolveProfile(context);
        /** Pi's saved default provider and model, read beside bedrock.json (never rewritten here). */
        const savedDefaults = (): { provider?: string; model?: string } => {
            try {
                const settings = JSON.parse(
                    readFileSync(path.join(config.agentDir ?? agentFolder(profileEnv), "settings.json"), "utf8"),
                ) as { defaultProvider?: unknown; defaultModel?: unknown };
                return {
                    ...(typeof settings.defaultProvider === "string" && settings.defaultProvider !== ""
                        ? { provider: settings.defaultProvider }
                        : {}),
                    ...(typeof settings.defaultModel === "string" && settings.defaultModel !== ""
                        ? { model: settings.defaultModel }
                        : {}),
                };
            } catch {
                return {};
            }
        };
        /** A one-line start-up notice, once per marker file beside `.bedrock-first-run`. */
        const noticeOnce = (context: ExtensionContext, markerName: string, line: string): void => {
            if (!context.hasUI) return;
            const marker = path.join(agentFolder(options.env), markerName);
            if (existsSync(marker)) return;
            try {
                writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
            } catch {
                return;
            }
            context.ui.notify(line, "warning");
        };
        /**
         * Design §6: `preset` is the model a NEW session opens on, when Pi restored no model and settings hold no saved
         * default. A cold cache starts its discovery and selects the model when that lands.
         */
        const openOnRequestedPreset = async (context: ExtensionContext): Promise<void> => {
            if (context.model !== undefined && context.model.provider !== "unknown") return;
            if (savedDefaults().provider !== undefined) return;
            const requested = config.preset;
            if (requested === undefined) return;
            const runtime = runtimeFor.get(requested);
            if (runtime === undefined) return;
            const select = async (): Promise<void> => {
                if (disposed) return;
                if (context.model !== undefined && context.model.provider !== "unknown") return;
                if (runtime.models.length === 0) return;
                await selectModel(runtime, context);
            };
            if (runtime.models.length > 0) {
                await select();
                return;
            }
            void runtime
                .refresh(false)
                .then(select)
                .catch(() => {});
        };
        pi.on("session_start", async (_event, context) => {
            disposed = false;
            ctx = context;
            primary.markStoredAuthSeen();
            const choice = await resolveProfile(context);
            if (config.presetUnknown !== undefined) {
                context.ui.notify(
                    `Bedrock: preset ${config.presetUnknown} is not defined; known: ${(config.presetNames ?? []).join(", ") || "none"}.`,
                    "warning",
                );
            } else if (options.preserveNativeAuth) {
                // The native provider's own credentials decide; nothing here is reported.
            } else if (choice.ambient === true) {
                if (failed) context.ui.notify("Bedrock unavailable; update Pi and /reload.", "warning");
            } else if (choice.profile === undefined) {
                firstRunNotice(context);
            } else if (choice.problem !== undefined) {
                context.ui.notify(choice.problem, "warning");
            } else if (choice.exists === false) {
                context.ui.notify(missingProfileNotice(choice), "warning");
            } else if (failed) context.ui.notify("Bedrock unavailable; update Pi and /reload.", "warning");
            else if (!models.length && !primary.autoProfile)
                context.ui.notify(
                    "Bedrock: reading the models from AWS; they appear in /model in a few seconds (first start).",
                    "info",
                );
            // `preset` opens a new session on its model when Pi restored none and no saved default says otherwise.
            await openOnRequestedPreset(context);
            const focus = currentRuntime(context);
            if (focus !== primary) focus.markStoredAuthSeen();
            // Design §5/§8: one line for a saved default whose preset is gone, and one for the 0.6.3 upgrade.
            const saved = savedDefaults();
            const savedPreset = saved.provider === undefined ? undefined : presetOf(saved.provider);
            if (savedPreset !== undefined && !presetCatalogNames.includes(savedPreset))
                noticeOnce(
                    context,
                    ".bedrock-removed-preset",
                    `Bedrock: ${saved.model ?? "the saved default model"} is saved under ${saved.provider}, whose preset no longer exists. Choose another with /model; Pi keeps the saved settings.`,
                );
            const requestedPreset = config.preset;
            if (requestedPreset !== undefined && saved.provider === JIG_BEDROCK && saved.model !== undefined) {
                const presetRuntime = runtimeFor.get(requestedPreset);
                if (
                    presetRuntime !== undefined &&
                    presetRuntime.models.length > 0 &&
                    !topLevel.models.some((model) => model.id === saved.model) &&
                    presetRuntime.models.some((model) => model.id === saved.model)
                )
                    noticeOnce(
                        context,
                        ".bedrock-preset-upgrade",
                        `Bedrock: preset ${requestedPreset} is saved, but the saved default model ${saved.model} is only in it. Run /bedrock use ${requestedPreset}, then Ctrl+S in /model.`,
                    );
            }
            // Start in the background; session startup never awaits AWS. No profile and no ambient chain means
            // discovery cannot succeed, so it is not started (the notice above already says what to do).
            const canRefresh =
                config.presetUnknown === undefined &&
                (choice.ambient === true || (config.profile !== undefined && choice.exists !== false));
            if (backgroundRefresh && canRefresh) void refresh(false).catch(() => {});
            // Every preset's own models load in the background too, in parallel and without holding the session.
            // Their failures stay quiet here; the line that counts them belongs with the routing step.
            if (backgroundRefresh)
                for (const runtime of runtimes) {
                    if (runtime === primary) continue;
                    void (async () => {
                        const own = await runtime.resolveProfile(context);
                        if (disposed) return;
                        if (own.ambient !== true && (runtime.config.profile === undefined || own.exists === false))
                            return;
                        await runtime.refresh(false, false, true);
                    })().catch(() => {});
                }
            void focus.spend
                .start(
                    config.agentDir ?? agentFolder(options.env),
                    context,
                    (arn) => focus.models.find((model) => model.arn === arn)?.id,
                )
                .catch(() => {});
            // UI notices are queued until the session's UI is ready; the footer can be set immediately.
            setTimeout(() => {
                if (ctx === context) focus.spend.notice(context, true);
            }, 1000).unref();
        });
        pi.on("message_end", (event, context) => {
            const message = event.message as unknown as Json | undefined;
            if (
                message?.role !== "assistant" ||
                !isOwnProvider(typeof message.provider === "string" ? message.provider : undefined)
            )
                return;
            // The reply names its own provider: a preset's spend line is recorded under that preset, whatever is selected now.
            const runtime = runtimeForProviderId(String(message.provider)) ?? currentRuntime(context);
            if (message.stopReason !== "error" && message.stopReason !== "aborted") runtime.markSignedIn();
            const selected = runtime.models.find((model) => model.id === message.model);
            const session = context.sessionManager.getSessionId();
            const result = runtime.spend.record(message as Json, session, selected);
            const writeError = result?.error === undefined ? undefined : runtime.spend.takeWriteError(session);
            if (writeError !== undefined && context.hasUI) context.ui.notify(writeError, "warning");
            const active = currentRuntime(context);
            active.spend.updateFooter(context);
            active.spend.notice(context);
            if (active.config.spendCommand !== undefined)
                void active.spend.refresh(false).then(() => active.spend.updateFooter(context));
        });
        pi.on("model_select", (event, context) => {
            // A preset removed while its model was in use loses its provider at the first model change away from it.
            if (context.model !== undefined && !unregisterLater.has(context.model.provider ?? "")) {
                for (const providerId of [...unregisterLater]) {
                    unregisterLater.delete(providerId);
                    const retired = runtimeByProvider.get(providerId);
                    if (retired !== undefined) unregisterRuntime(retired);
                    else {
                        try {
                            pi.unregisterProvider(providerId);
                        } catch {}
                    }
                }
            }
            const runtime = currentRuntime(context);
            runtime.spend.updateFooter(context);
            // A pick in /model re-points the footer and checks that preset's budget; another provider's model clears it.
            if ((event.source === "set" || event.source === "cycle") && isOwnModel(context.model))
                runtime.spend.notice(context);
        });
        // Registered after the provider's session_start handler, so a refresh that is already running when the guard
        // checks the model list can explain a missing saved model; a refresh that never starts cannot.
        guard = registerBedrockSelectionGuard(pi, models, {
            ...(options.selection ?? { agentDir: config?.agentDir }),
            deferStartupWarning: () => (ctx === undefined ? primary : currentRuntime(ctx)).loading(),
            discoverySlow: () => (ctx === undefined ? primary : currentRuntime(ctx)).isDiscoverySlow(),
            isRegistered: (providerId) => runtimeForProviderId(providerId) !== undefined,
            modelsFor: (providerId) => runtimeForProviderId(providerId)?.models,
        });
        // Sign in when Pi starts and the session has expired, through the recovery the commands and requests share.
        // Registered after the handler above, so the profile it resolves is already in force.
        registerSignInAtStart(pi, {
            signInAtStart: config.signInAtStart,
            profile: () => (ctx === undefined ? primary : currentRuntime(ctx)).currentProfile(),
            recover: recoveryForLogin,
            check: options.ssoCheck ?? ((profile, signal) => checkSso(profile, systemSsoDeps(options.env), signal)),
            refresh: () => (ctx === undefined ? primary : currentRuntime(ctx)).refresh(false),
            models: () => (ctx === undefined ? primary : currentRuntime(ctx)).models.length,
        });
        pi.on("session_shutdown", () => {
            lifetime.abort();
            disposed = true;
            if (ctx?.hasUI) ctx.ui.setStatus("jig-bedrock", undefined);
            ctx = undefined;
        });
        return { models, refresh, failed };
    };
}
