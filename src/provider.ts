// The Bedrock model provider: your inference profiles as Pi models, AWS SSO recovery, a monthly spend figure and
// the commands around them. Its settings are the `bedrock` section when Jig is present, or the extension's own settings (see config.ts); it also
// publishes the optional display events in events.ts.
//
// The factory registers and reads settings, and no more: AWS, usage program and the browser are touched in `session_start`, in the
// background, or by a command the user types.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAwsConfig } from "./aws-config-write.ts";
import type { CatalogSource, Status } from "./aws-discovery.ts";
import { createAwsDiscovery, discoveryHelp } from "./aws-discovery.ts";
import {
    awsConfigFile,
    checkedRecovery,
    isSsoProfile,
    profileProblem,
    type VerifyResult,
    verifyAwsProfile,
} from "./aws-profile.ts";
import { createSignedFetch } from "./bedrock-fetch.ts";
import type { BudgetSource } from "./budget.ts";
import { createBudget } from "./budget.ts";
import type { TeamBedrockModel } from "./catalog.ts";
import {
    discoveredProfiles,
    registerBedrockSelectionGuard,
    registerTeamBedrock,
    updateModels,
    usePiAnthropicRegistry,
    usePiRegistry,
} from "./catalog.ts";
import { isObject } from "./check.ts";
import { isSubagentChild } from "./child.ts";
import { registerStatisticsCommands } from "./commands.ts";
import type { BedrockApi, ConfigResult, ResolvedConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { MODEL_NAMES_EVENT, modelNames, SEGMENT_EVENT, spendSegment } from "./events.ts";
import { isJigBedrock, JIG_BEDROCK } from "./identity.ts";
import { jigApi } from "./jig/client.ts";
import type { JigApi } from "./jig/types.ts";
import type { RecoveryOptions } from "./login.ts";
import { createRecovery } from "./login.ts";
import { runLoginFlow } from "./login-flow.ts";
import { findPiHost, loadCredentialProvider } from "./pi-host.ts";
import type { ListProfiles, ProfileChoice } from "./profile.ts";
import {
    createListProfiles,
    createProfileAuth,
    loginOutcomeMessage,
    memoizedList,
    missingProfileNotice,
    NO_PROFILE,
    ProfileResolver,
} from "./profile.ts";
import { saveDiscoverySettings } from "./settings-write.ts";
import type { AwsCredentials } from "./sigv4.ts";
import type { Recover, RecoveredBedrock } from "./sso.ts";
import { noticeFor, registerBedrockSsoRecovery, shareRecovery } from "./sso.ts";
import type { SsoState } from "./sso-check.ts";
import { checkSso, systemSsoDeps } from "./sso-check.ts";
import { registerSignInAtStart } from "./start-sign-in.ts";
import type { StatisticsSource } from "./statistics.ts";
import { createStatistics } from "./statistics.ts";
import { registerSwitchNotice } from "./switch-cost.ts";

export type { BudgetSource, CatalogSource, Recover, ResolvedConfig, StatisticsSource };

export interface EventNames {
    provider: string;
    usage: string;
}

export interface BedrockOptions {
    catalog?: CatalogSource;
    /** The settings, already resolved. Without them they are read from the `bedrock` section through `api`. */
    config?: ResolvedConfig;
    /** jig-core's API, for reading the settings. */
    api?: JigApi;
    ssoRecover?: Recover;
    /** The parts of the default sign-in a test replaces: the program that starts the login, its lock, its environment, WSL. */
    login?: Omit<RecoveryOptions, "say">;
    /** Whether the profile's SSO session is still good, for the sign-in at start. Without it the AWS SDK in Pi's install answers. */
    ssoCheck?: (profile: string, signal: AbortSignal) => Promise<SsoState>;
    /** `aws configure list-profiles`, for tests. */
    listProfiles?: ListProfiles;
    /** The same listing with /login's longer timeout, for tests. */
    loginListProfiles?: ListProfiles;
    /** The STS check /login runs; without it `aws sts get-caller-identity`. */
    verifyProfile?: (profile: string | undefined, signal: AbortSignal) => Promise<VerifyResult>;
    /** The SSO sign-in /login runs; without it the shared recovery. */
    signInProfile?: (profile: string, signal: AbortSignal) => Promise<void>;
    budget?: BudgetSource;
    statistics?: StatisticsSource;
    events?: EventNames;
    selection?: { agentDir?: string; explicitSelection?: () => boolean };
    transformModels?: (models: TeamBedrockModel[]) => TeamBedrockModel[];
    backgroundRefresh?: boolean;
    usageEvents?: boolean;
    preserveNativeAuth?: boolean;
    /** The AWS credentials of the Messages route; the SDK's default provider for the profile unless a test supplies them. */
    credentials?: () => Promise<AwsCredentials>;
    /** The fetch signed requests go through, so a test can watch them. */
    fetch?: typeof globalThis.fetch;
    env?: NodeJS.ProcessEnv;
}

export interface BedrockHandle {
    models: TeamBedrockModel[];
    refresh: (force?: boolean) => Promise<Status>;
    /** Re-read the settings; `live` also resolves the profile and refreshes when a session is already running. */
    applySettings: (live?: boolean) => void;
    failed: boolean;
}

/** Pi's agent folder, from PI_CODING_AGENT_DIR or HOME, shared by settings and notices. */
export function agentFolder(env: NodeJS.ProcessEnv = process.env): string {
    return env.PI_CODING_AGENT_DIR === undefined || env.PI_CODING_AGENT_DIR === ""
        ? path.join(env.HOME ?? homedir(), ".pi", "agent")
        : env.PI_CODING_AGENT_DIR;
}

/** The user's own bedrock settings file; `bedrock` or the file itself may hold the keys. */
function userSettings(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
    try {
        const raw = JSON.parse(readFileSync(path.join(agentFolder(env), "bedrock.json"), "utf8")) as unknown;
        const value = isObject(raw) && isObject(raw.bedrock) ? raw.bedrock : raw;
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Jig's section without the two keys that start programs. */
function safeSection(api: JigApi | undefined): { section?: Record<string, unknown>; dropped: string[] } {
    const raw = api?.config.section("bedrock");
    if (!isObject(raw)) return { dropped: [] };
    const section = { ...raw };
    const dropped = ["ssoLoginCommand", "usageDir", "browser"].filter((key) => key in section);
    delete section.ssoLoginCommand;
    delete section.usageDir;
    delete section.browser;
    return { section, dropped };
}

/** The user's bedrock.json first; jig-core's section on top, except the two program keys. */
export function settingsFrom(
    api: JigApi | undefined,
    env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
    const { section } = safeSection(api);
    const user = userSettings(env);
    if (user === undefined) return section;
    return section === undefined ? user : { ...user, ...section };
}

export function createJigBedrock(
    options: BedrockOptions = {},
): (pi: ExtensionAPI) => Promise<BedrockHandle | undefined> {
    return async (pi) => {
        const resolved: ConfigResult = options.config
            ? { config: options.config }
            : loadConfig({
                  raw: settingsFrom(options.api, options.env),
                  ...(options.env === undefined ? {} : { env: options.env }),
              });
        const config = resolved.config;
        const currentApi = (): BedrockApi => config?.api ?? "messages";
        const events = options.events ?? { provider: "jig-bedrock:provider", usage: "jig-bedrock:usage" };
        const models: TeamBedrockModel[] = [];
        let discoverySlow = false;
        let refreshInFlight: Promise<Status> | undefined;
        let guard: ReturnType<typeof registerBedrockSelectionGuard>;
        if (!config) {
            const file = path.join(agentFolder(options.env), "bedrock.json");
            const where = `Fix bedrock in jig.json or in ${file}, then /reload.`;
            pi.on("session_start", (_event, ctx) =>
                ctx.ui.notify(`Bedrock provider disabled: ${resolved.error} ${where}`, "warning"),
            );
            return undefined;
        }
        // Where the profile comes from, resolved once a session starts: the setting, /login's credential, the AWS
        // environment, then the default profile. Pi's credential is read through its registry, never from auth.json.
        const profileEnv = options.env ?? (options.config === undefined ? process.env : {});
        const profiles = new ProfileResolver({
            settings: { setting: config.profile, settingSource: config.profileSource, env: profileEnv },
            ...(options.listProfiles === undefined ? {} : { listProfiles: options.listProfiles }),
        });
        const currentProfile = (): string | undefined => (options.preserveNativeAuth ? undefined : config.profile);
        let lastChoice: ProfileChoice = {};
        let afterProfileLogin:
            | ((
                  profile: string | undefined,
                  interaction: ProviderAuthInteraction,
                  signal: AbortSignal,
              ) => Promise<void>)
            | undefined;
        const loginListProfiles = memoizedList(options.loginListProfiles ?? createListProfiles(profileEnv, 10_000));
        // /login's guided choice: the AWS CLI is the only place a secret is entered, and the profile is verified before
        // the credential is stored. A fresh listing is used after the access-key/role guidance.
        const guided = (interaction: ProviderAuthInteraction) =>
            runLoginFlow(interaction, {
                listProfiles: loginListProfiles,
                refreshProfiles: () => createListProfiles(profileEnv, 10_000)(),
                isSso: (profile) => isSsoProfile(profile, profileEnv),
                verify: (profile, signal) =>
                    options.verifyProfile?.(profile, signal) ?? verifyAwsProfile(profile, { env: profileEnv, signal }),
                signIn: (profile, signal) =>
                    options.signInProfile?.(profile, signal) ?? recoveryForLogin(profile, signal, "manual"),
                saveDiscovery: (settings) =>
                    saveDiscoverySettings(profileEnv, settings, safeSection(apiForSettings()).section),
                regions: config.regions,
                configFile: awsConfigFile(profileEnv),
                writeConfig: (sections) => writeAwsConfig(profileEnv, sections),
            });
        const auth = createProfileAuth(profiles, loginListProfiles, {
            guided,
            afterLogin: (profile, interaction, signal) =>
                afterProfileLogin?.(profile, interaction, signal) ?? Promise.resolve(),
        });
        const identity = { profile: currentProfile, auth };
        // jig-core can appear after this provider (the install order is Pi's load order). Re-read the settings then, and
        // at every session start: the same `bedrock` section must win in either order.
        const apiForSettings = (): JigApi | undefined => options.api ?? jigApi();
        const applySettings = (live = false): void => {
            if (options.config !== undefined) return;
            const next = loadConfig({
                raw: settingsFrom(apiForSettings(), options.env),
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(config.agentDir === undefined ? {} : { agentDir: config.agentDir }),
            });
            if (!next.config) {
                if (ctx) ctx.ui.notify(`Bedrock settings were not applied: ${next.error}`, "warning");
                return;
            }
            for (const key of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[key];
            Object.assign(config, next.config);
            profiles.updateSetting(config.profile, config.profileSource);
            if (live && ctx) {
                void resolveProfile(ctx)
                    .then(() => (backgroundRefresh ? refresh(false) : undefined))
                    .catch(() => undefined);
            }
        };
        const catalog = options.catalog ?? createAwsDiscovery(config);
        const statistics = options.statistics ?? createStatistics(config);
        const budget = options.budget ?? createBudget(config, undefined, undefined, undefined, statistics);
        registerSwitchNotice(pi, { env: options.env });
        const lifetime = new AbortController();
        // A subagent child never refreshes the catalog, polls usage program or publishes usage: the parent does, and nothing there shows it.
        const child = isSubagentChild(options.env);
        const usageEvents = options.usageEvents !== false && !child;
        const backgroundRefresh = options.backgroundRefresh !== false && !child;
        let ctx: ExtensionContext | undefined;
        let native: Provider | undefined;
        let messages: RecoveredBedrock["messages"];
        let failed = false;
        let disposed = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const readModels = () => {
            const result = discoveredProfiles(catalog.load(), config.usageDir, currentApi());
            if (options.transformModels) result.available = options.transformModels(result.available);
            return result;
        };
        const publish = (): void => {
            if (!ctx) return;
            const spent = budget.load();
            pi.events?.emit(events.usage, { sessionId: ctx.sessionManager.getSessionId(), budget: spent });
            pi.events?.emit(SEGMENT_EVENT, spendSegment(spent, Date.now()));
        };
        const provider = (): void => {
            pi.events?.emit(events.provider, {
                sessionId: ctx?.sessionManager.getSessionId(),
                budget: budget.load(),
                models,
                unavailable: readModels().unavailable,
                status: failed ? "failed" : models.length ? "ready" : "absent",
            });
            if (usageEvents) pi.events?.emit(MODEL_NAMES_EVENT, modelNames(models));
        };
        // A repair the sign-in makes for WSL is told in one line, the way the notices of a waiting request are.
        const say = (line: string): void => {
            if (ctx) noticeFor(ctx)(line, "info");
        };
        const recovery = options.ssoRecover ?? createRecovery(config, { ...options.login, say });
        // The same preflight guards both the command and the automatic repair: the profile must exist (when a person is
        // waiting) and be an SSO profile, or no `aws sso login` child starts.
        const recoveryForLogin =
            options.ssoRecover ?? checkedRecovery(recovery, { manualList: loginListProfiles, env: profileEnv });
        // The Messages route signs with the profile's SSO credentials; the credential chain is loaded from Pi's install on the
        // first request, so nothing here reaches AWS at registration. Tests supply both.
        const signedFetch = createSignedFetch({
            credentials:
                options.credentials ??
                (() => {
                    // One chain per profile, made on the first request: it caches the role's credentials and
                    // refreshes them. No profile means the SDK's own chain (environment, container, instance).
                    const host = findPiHost(options.env);
                    let chain: { profile: string | undefined; load: () => Promise<AwsCredentials> } | undefined;
                    return async () => {
                        const profile = currentProfile();
                        let entry = chain;
                        if (entry === undefined || entry.profile !== profile) {
                            const provider = loadCredentialProvider(host);
                            entry = {
                                profile,
                                load: provider(
                                    profile === undefined ? {} : { profile },
                                ) as () => Promise<AwsCredentials>,
                            };
                            chain = entry;
                        }
                        return entry.load();
                    };
                })(),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        try {
            const recovered = await registerBedrockSsoRecovery(
                pi,
                recoveryForLogin,
                currentProfile,
                (profile, signal) => profileProblem(profile, { list: loginListProfiles, env: profileEnv, signal }),
            );
            native = recovered.provider;
            messages = recovered.messages;
            await usePiAnthropicRegistry();
            usePiRegistry(native);
            models.push(...readModels().available);
            await registerTeamBedrock(
                pi,
                config.agentDir || "",
                native,
                models,
                catalog.load,
                identity,
                messages,
                signedFetch,
            );
        } catch {
            failed = true;
        }
        let noticeFailureOnce = false;
        const refresh = (force = true, notifyFailure = false): Promise<Status> => {
            noticeFailureOnce ||= notifyFailure;
            if (refreshInFlight !== undefined) return refreshInFlight;
            refreshInFlight = (async (): Promise<Status> => {
                const status = await catalog.refresh(force);
                if (disposed) return status;
                discoverySlow = status === "timeout";
                if (status !== "ok" && ctx && (noticeFailureOnce || models.length === 0)) {
                    const message =
                        status === "timeout"
                            ? "AWS discovery is slow; Bedrock models are not loaded yet. Try again in a moment or run /bedrock-refresh."
                            : `Bedrock could not load models. ${discoveryHelp(status)}`;
                    ctx.ui.notify(message, "warning");
                }
                const updated = readModels().available;
                const selected = ctx?.model;
                if (isJigBedrock(selected)) {
                    const previous = models.find((m) => m.id === selected?.id);
                    const replacement = updated.find((m) => m.id === selected?.id);
                    if (
                        !replacement ||
                        (previous &&
                            (previous.arn !== replacement.arn ||
                                previous.foundationModelId !== replacement.foundationModelId))
                    ) {
                        guard.blockUntilChoice();
                    }
                }
                const change = updateModels(models, updated);
                const current = catalog.load();
                const problems = current?.errors ?? [];
                const warnings = current?.warnings ?? [];
                if (ctx && (change.added || change.removed || problems.length > 0 || warnings.length > 0)) {
                    const detail = [
                        `Bedrock catalog updated: ${change.added} added, ${change.removed} removed.`,
                        ...warnings,
                        ...problems.map((problem) => `${problem.profile}: ${problem.message}.`),
                        "Choose /model if your selection was removed.",
                    ].join(" ");
                    ctx.ui.notify(detail, problems.length > 0 || warnings.length > 0 ? "warning" : "info");
                }
                if (change.changed && native) {
                    await registerTeamBedrock(
                        pi,
                        config.agentDir || "",
                        native,
                        models,
                        catalog.load,
                        identity,
                        messages,
                        signedFetch,
                    );
                }
                provider();
                return status;
            })().finally(() => {
                refreshInFlight = undefined;
                noticeFailureOnce = false;
            });
            return refreshInFlight;
        };
        afterProfileLogin = async (profile, interaction, signal) => {
            config.profile = profile;
            profiles.stored = profile;
            lastChoice = profile === undefined ? { ambient: true } : { profile, source: "login", exists: true };
            interaction.notify({ type: "progress", message: "Loading Bedrock models…" });
            // The guided flow saved discovery choices to bedrock.json; read them before the first refresh. A
            // bedrock.profile setting still wins over the profile just chosen, as it does everywhere else.
            applySettings(false);
            if (profile !== undefined && ctx) {
                const resolved = await resolveProfile(ctx);
                if (resolved.profile !== undefined && resolved.profile !== profile)
                    interaction.notify({
                        type: "info",
                        message: `bedrock.profile ${resolved.profile} overrides the profile chosen at /login.`,
                    });
            }
            let settled = true;
            const timeout = new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    settled = false;
                    resolve();
                }, 20_000);
                timer.unref();
            });
            await Promise.race([
                refresh(true)
                    .then(() => undefined)
                    .catch(() => undefined),
                timeout,
            ]);
            if (signal.aborted) return;
            const message = loginOutcomeMessage(models.length, settled);
            interaction.notify({ type: "info", message });
            // The login dialog closes as soon as the credential is returned; defer the chat line until after that, so
            // the dialog's teardown cannot clear the only lasting explanation of what happened.
            const context = ctx;
            if (context) {
                const timer = setTimeout(() => context.ui.notify(message, "info"), 300);
                timer.unref();
            }
        };
        pi.registerCommand("bedrock-refresh", {
            description: "Refresh your Bedrock models",
            handler: async (_args, context) => {
                if (!options.preserveNativeAuth) {
                    // The profile may have just changed at /login: resolve it again before discovery, so a refresh
                    // does not need a reload.
                    lastChoice = await resolveProfile(context);
                    if (lastChoice.ambient !== true && lastChoice.profile === undefined) {
                        context.ui.notify(NO_PROFILE, "warning");
                        return;
                    }
                    if (lastChoice.profile !== undefined && lastChoice.exists === false) {
                        context.ui.notify(missingProfileNotice(lastChoice), "warning");
                        return;
                    }
                }
                const status = await refresh(true, true);
                if (status === "ok")
                    context.ui.notify(`Bedrock catalog: ${models.length} models. Choose /model.`, "info");
            },
        });
        registerStatisticsCommands(pi, {
            config,
            statistics,
            catalog,
            models: () => models,
            budget,
            publish,
            profiles,
            stored: () => profiles.stored,
            listProfiles: loginListProfiles,
            env: profileEnv,
        });
        const resolveProfile = async (context: ExtensionContext): Promise<ProfileChoice> => {
            if (!options.preserveNativeAuth) {
                // Pi resolves this provider's auth from its credential store; the credential is passed to the provider's
                // resolve, which records /login's env.AWS_PROFILE here. Nothing reads auth.json.
                const registry = (
                    context as {
                        modelRegistry?: { getProviderAuth?: (id: string) => Promise<unknown> };
                    }
                ).modelRegistry;
                try {
                    await registry?.getProviderAuth?.(JIG_BEDROCK);
                } catch {}
            }
            const choice = await profiles.resolve({ signal: lifetime.signal });
            config.profile = choice.profile;
            lastChoice = choice;
            return choice;
        };
        pi.on("session_start", async (_event, context) => {
            disposed = false;
            applySettings(false);
            ctx = context;
            const dropped = safeSection(apiForSettings()).dropped;
            if (dropped.length > 0)
                context.ui.notify(
                    `Bedrock ignores ${dropped.join(" and ")} from a project's jig.json; set them in ${path.join(agentFolder(options.env), "bedrock.json")} or the environment.`,
                    "warning",
                );
            const choice = await resolveProfile(context);
            provider();
            if (usageEvents) publish();
            const unavailable = readModels().unavailable;
            if (options.preserveNativeAuth) {
                // The native provider's own credentials decide; nothing here is reported.
            } else if (choice.ambient === true) {
                if (failed) context.ui.notify("Bedrock unavailable; update Pi and /reload.", "warning");
            } else if (choice.profile === undefined) {
                context.ui.notify(NO_PROFILE, "warning");
            } else if (choice.problem !== undefined) {
                context.ui.notify(choice.problem, "warning");
            } else if (choice.exists === false) {
                context.ui.notify(missingProfileNotice(choice), "warning");
            } else if (failed) context.ui.notify("Bedrock unavailable; update Pi and /reload.", "warning");
            else if (unavailable.length > 0)
                context.ui.notify(
                    `${unavailable.length} Bedrock profiles unavailable: ${unavailable[0]?.reason}`,
                    "warning",
                );
            else if (!models.length)
                context.ui.notify("Bedrock models are not loaded yet; checking your AWS profiles now.", "info");
            // Start in the background; session startup never awaits AWS or usage program. No profile and no ambient
            // chain means discovery cannot succeed, so it is not started (the notice above already says what to do).
            const canRefresh = choice.ambient === true || (config.profile !== undefined && choice.exists !== false);
            if (backgroundRefresh && canRefresh) void refresh(false).catch(() => {});
            if (usageEvents && context.mode === "tui") {
                const tick = (): void => {
                    if (isJigBedrock(ctx?.model)) {
                        void budget
                            .refresh({ signal: lifetime.signal })
                            .then(publish)
                            .catch(() => {});
                    }
                };
                tick();
                timer = setInterval(tick, 10_000);
                timer.unref();
            }
        });
        // Registered after the provider's session_start handler, so a refresh that is already running when the guard
        // checks the model list can explain a missing saved model; a refresh that never starts cannot.
        guard = registerBedrockSelectionGuard(pi, models, {
            ...(options.selection ?? { agentDir: config?.agentDir }),
            deferStartupWarning: () => refreshInFlight !== undefined && models.length === 0,
            discoverySlow: () => discoverySlow,
        });
        // Sign in when Pi starts and the session has expired, through the recovery the commands and requests share. Not
        // in a child: the parent does it, and a second window from a child would be one nobody expects. Registered after
        // the handler above, so the profile it resolves is already in force.
        if (!child) {
            registerSignInAtStart(pi, {
                signInAtStart: config.signInAtStart,
                profile: () => currentProfile(),
                recover: shareRecovery(recovery),
                check: options.ssoCheck ?? ((profile, signal) => checkSso(profile, systemSsoDeps(options.env), signal)),
                refresh: () => refresh(false),
            });
        }
        if (usageEvents) pi.on("model_select", publish);
        pi.on("session_shutdown", () => {
            lifetime.abort();
            disposed = true;
            ctx = undefined;
            if (timer) clearInterval(timer);
        });
        return { models, refresh, applySettings, failed };
    };
}
