// One preset's Bedrock state: the settings in force, the catalog cache and its file, the model list, the AWS profile and
// its sign-in, the signed fetch, the refusals remembered for that profile, the spend view, and the Pi provider
// registration that carries them. Everything machine-wide (the commands, the footer, the selection guard, the native
// Bedrock provider, the SSO recovery) stays in provider.ts; the runtime reaches it through its host.
import path from "node:path";
import type { ApiKeyCredential, ProviderAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
    type CatalogSource,
    createAwsDiscovery,
    discoveryHelp,
    partialDiscovery,
    problemSummary,
    type Status,
} from "./aws-discovery.ts";
import { isSsoProfile } from "./aws-profile.ts";
import { createSignedFetch } from "./bedrock-fetch.ts";
import { catalogFileFor } from "./cache-root.ts";
import { type BedrockModel, discoveredProfiles, type registerBedrockSelectionGuard, updateModels } from "./catalog.ts";
import type { ConfigResult, ResolvedConfig } from "./config.ts";
import { loadCredentialProvider } from "./credential-provider.ts";
import { type DebugLog, withDebugCatalog } from "./debug-log.ts";
import { isOwnModel } from "./identity.ts";
import { createProfileAuth, type ListProfiles, type ProfileChoice, ProfileResolver } from "./profile.ts";
import { isRefusalError, isRefused, rememberRefusal } from "./refusals.ts";
import type { AwsCredentials } from "./sigv4.ts";
import { SpendTracker } from "./spend.ts";
import type { RecoveredBedrock } from "./sso.ts";

/** The parts of provider.ts's options a runtime reads; a provider passes its whole options object. */
export interface RuntimeOptions {
    catalog?: CatalogSource;
    spend?: SpendTracker;
    preserveNativeAuth?: boolean;
    transformModels?: (models: BedrockModel[]) => BedrockModel[];
    listProfiles?: ListProfiles;
    credentials?: (profile?: string) => Promise<AwsCredentials>;
    fetch?: typeof globalThis.fetch;
    discoveryCredentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
    env?: NodeJS.ProcessEnv;
}

/** The one selection guard a provider registers once its runtimes exist. */
export type SelectionGuard = ReturnType<typeof registerBedrockSelectionGuard>;

/** What a runtime shares with the provider and the other runtimes. */
export interface PresetRuntimeHost {
    /** Pi's API, for the provider registration. */
    pi: Pick<ExtensionAPI, "registerProvider">;
    env: NodeJS.ProcessEnv;
    options: RuntimeOptions;
    /** The one debug log of the package. */
    debug: DebugLog;
    /** The session context, between session_start and shutdown. */
    context(): ExtensionContext | undefined;
    /** Pi's own Bedrock provider and Messages streams, after registerBedrockSsoRecovery. */
    streams(): RecoveredBedrock | undefined;
    /** The one selection guard, registered after the provider. */
    guard(): SelectionGuard | undefined;
    /** The folder Pi keeps auth.json in. */
    agentDir(): string;
    /** The session's lifetime signal, for profile resolution. */
    signal(): AbortSignal;
    /** True after session_shutdown: a refresh that lands then stays quiet. */
    disposed(): boolean;
    /** The first-run line, which only one session start may write. */
    firstRunNotice(context: ExtensionContext): void;
    /** The one provider registration path, given the runtime whose models changed. */
    registerModels(runtime: PresetRuntime): Promise<void>;
    /** How many per-scope catalog files to keep: one per runtime plus a spare (design §7). */
    catalogKeep(): number;
    /** /login's guided flow and the work after it; the provider owns the prompts, the runtime says whose preset. */
    login: {
        listed: ListProfiles;
        guided(runtime: PresetRuntime, interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;
        after(
            runtime: PresetRuntime,
            profile: string | undefined,
            interaction: ProviderAuthInteraction,
            signal: AbortSignal,
        ): Promise<void>;
    };
}

export interface PresetRuntimeDeps {
    host: PresetRuntimeHost;
    config: ResolvedConfig;
    /** The Pi provider id this runtime's models live under (`jig-bedrock` for the top level). */
    providerId: string;
    displayName: string;
}

/**
 * The runtime of one preset. Its `config` is the same object throughout, so the spend tracker and the profile resolver
 * keep pointing at the settings in force; a preset switch replaces its fields, recreates the catalog and registers the
 * provider again.
 */
export class PresetRuntime {
    readonly providerId: string;
    readonly displayName: string;
    readonly config: ResolvedConfig;
    readonly profiles: ProfileResolver;
    readonly auth: ProviderAuth;
    readonly spend: SpendTracker;
    readonly signedFetch: typeof globalThis.fetch;
    readonly models: BedrockModel[] = [];
    catalog: CatalogSource;
    lastChoice: ProfileChoice = {};
    /** Set when a save or a switch makes the next refresh explain a changed model count. */
    settingsChanged = false;
    settingsBaseline: number | undefined;
    signInConfirmed = false;
    storedAuthSeen = false;
    refusalAccount: string | undefined;
    autoProfile = false;
    autoProfileFailed = false;
    private readonly host: PresetRuntimeHost;
    private discoverySlow = false;
    private noticeFailureOnce = false;
    private saveWarned = false;
    private refreshInFlight: Promise<Status> | undefined;

    constructor(deps: PresetRuntimeDeps) {
        this.host = deps.host;
        this.providerId = deps.providerId;
        this.displayName = deps.displayName;
        this.config = deps.config;
        this.profiles = new ProfileResolver({
            settings: { setting: this.config.profile, settingSource: this.config.profileSource, env: this.host.env },
            ...(this.host.options.listProfiles === undefined ? {} : { listProfiles: this.host.options.listProfiles }),
        });
        this.auth = createProfileAuth(this.profiles, this.host.login.listed, {
            unavailable: () => this.autoProfileFailed && this.models.length === 0,
            guided: (interaction) => this.host.login.guided(this, interaction),
            afterLogin: (profile, interaction, signal) => this.host.login.after(this, profile, interaction, signal),
        });
        this.catalog = this.buildCatalog();
        this.spend = this.host.options.spend ?? new SpendTracker(this.config, this.host.options.env ?? process.env);
        const suppliedCredentials = this.host.options.credentials;
        this.signedFetch = createSignedFetch({
            credentials:
                (suppliedCredentials === undefined ? undefined : () => suppliedCredentials(this.currentProfile())) ??
                (() => {
                    // One chain per profile, made on the first request: it caches the role's credentials and
                    // refreshes them. No profile means the SDK's own chain (environment, container, instance).
                    let chain: { profile: string | undefined; load: () => Promise<AwsCredentials> } | undefined;
                    return async () => {
                        const profile = this.currentProfile();
                        let entry = chain;
                        if (entry === undefined || entry.profile !== profile) {
                            const provider = await loadCredentialProvider();
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
            ...(this.host.options.fetch === undefined ? {} : { fetch: this.host.options.fetch }),
        });
    }

    /** The AWS profile of the settings in force; none with native auth, which lets Pi's own credential decide. */
    currentProfile(): string | undefined {
        return this.host.options.preserveNativeAuth ? undefined : this.config.profile;
    }

    identity(): { profile: () => string | undefined; auth: ProviderAuth } {
        return { profile: () => this.currentProfile(), auth: this.auth };
    }

    /** The credential Pi stores for this provider at /login; its contents are never read here. */
    storedAuthNow(): boolean {
        return readStoredCredential(this.providerId, path.join(this.host.agentDir(), "auth.json")) !== undefined;
    }

    storedAuthLost(): boolean {
        return this.storedAuthSeen && !this.storedAuthNow();
    }

    /** The AWS profile Pi stores for this provider at /login, for the factory's cache read only. */
    storedProfile(): string | undefined {
        const credential = readStoredCredential(this.providerId, path.join(this.host.agentDir(), "auth.json"));
        if (credential?.type !== "api_key") return undefined;
        const profile = credential.env?.AWS_PROFILE;
        return typeof profile === "string" && profile !== "" ? profile : undefined;
    }

    markStoredAuthSeen(): void {
        if (this.storedAuthNow()) this.storedAuthSeen = true;
    }

    markSignedIn(): void {
        this.signInConfirmed = true;
    }

    isDiscoverySlow(): boolean {
        return this.discoverySlow;
    }

    loading(): boolean {
        return this.refreshInFlight !== undefined && this.models.length === 0;
    }

    catalogPath(): string {
        return catalogFileFor(
            {
                profile: this.config.profile,
                mode: this.config.mode,
                tagKey: this.config.tagKey,
                tagValue: this.config.tagValue,
                activeTagKey: this.config.activeTagKey,
                activeTagValue: this.config.activeTagValue,
                profiles: this.config.profiles,
                regions: this.config.regions,
            },
            this.host.env,
            true,
        );
    }

    private buildCatalog(): CatalogSource {
        return withDebugCatalog(
            this.host.options.catalog ??
                createAwsDiscovery(this.config, () => this.catalogPath(), undefined, this.host.env, {
                    ...(this.host.options.fetch === undefined ? {} : { fetch: this.host.options.fetch }),
                    ...(this.host.options.discoveryCredentials === undefined
                        ? {}
                        : { credentials: this.host.options.discoveryCredentials }),
                    keepCatalogFiles: () => this.host.catalogKeep(),
                }),
            this.host.debug,
            () => ({ mode: this.config.mode, regions: this.config.regions }),
        );
    }

    /** A preset switch changed the settings: the catalog (and its file) belongs to the new ones. */
    rebuildCatalog(): void {
        this.catalog = this.buildCatalog();
    }

    /** The settings were replaced in place, so the resolver and the spend view follow them. */
    replaceConfig(next: ResolvedConfig): void {
        for (const key of Object.keys(this.config) as Array<keyof ResolvedConfig>)
            if (!(key in next)) delete this.config[key];
        Object.assign(this.config, next);
        this.profiles.updateSetting(this.config.profile, this.config.profileSource);
        this.lastChoice =
            this.config.profile === undefined
                ? { ambient: true }
                : {
                      profile: this.config.profile,
                      source: this.config.profileSource === "env" ? "env" : "setting",
                      exists: true,
                  };
    }

    applyResolved(next: ConfigResult): boolean {
        if (!next.config) return false;
        this.replaceConfig(next.config);
        return true;
    }

    /** The models the cached catalog holds, without the ones AWS refused for this profile. */
    readModels(): ReturnType<typeof discoveredProfiles> {
        const result = discoveredProfiles(this.catalog.load(), "", this.config);
        const account = this.catalog.load()?.account_id;
        this.refusalAccount = account;
        result.available = result.available.filter(
            (model) => !isRefused(this.host.env, this.config.profile, account, model.arn),
        );
        if (this.host.options.transformModels) result.available = this.host.options.transformModels(result.available);
        return result;
    }

    /** The cached catalog's models at the factory, before session_start and before any network. */
    loadCachedModels(): void {
        this.models.push(...this.readModels().available);
    }

    /** A request AWS refused for this profile: hide its model, remember it for seven days, and say why. */
    refusalMessage(model: BedrockModel, message: string): string | undefined {
        if (!isRefusalError(message, model.arn)) return undefined;
        const unremembered = rememberRefusal(
            this.host.env,
            this.config.profile,
            this.catalog.load()?.account_id,
            model.arn,
            model.id,
        );
        const index = this.models.findIndex((entry) => entry.arn === model.arn);
        if (index >= 0) this.models.splice(index, 1);
        this.host.guard()?.refusalHidden(model.id);
        void this.host.registerModels(this);
        const plain = `AWS refused ${model.id} for your AWS role (no permission to call this inference profile). It is hidden from /model. /bedrock refresh tries it again. If your organisation marks the usable profiles with a second tag, run /login again or /bedrock settings.`;
        return unremembered === undefined ? plain : `${plain}\n${unremembered.message}`;
    }

    async refresh(force = true, notifyFailure = false, quiet = false): Promise<Status> {
        this.noticeFailureOnce ||= notifyFailure;
        if (this.refreshInFlight !== undefined) return this.refreshInFlight;
        this.refreshInFlight = (async (): Promise<Status> => {
            const status = await this.catalog.refresh(force);
            if (this.host.disposed()) return status;
            let ctx = this.host.context();
            const save = this.catalog.saveFailure?.();
            if (save !== undefined && ctx !== undefined && !quiet && !this.saveWarned) {
                this.saveWarned = true;
                ctx.ui.notify(save.message, "warning");
            } else if (save === undefined) this.saveWarned = false;
            this.discoverySlow = status === "timeout";
            this.autoProfileFailed = this.autoProfile && status !== "ok";
            let failureNotice = false;
            if (!quiet && status !== "ok" && ctx && (this.noticeFailureOnce || this.models.length === 0)) {
                failureNotice = true;
                const reason = this.catalog.failure?.();
                if (this.autoProfile && this.lastChoice.profile === undefined && this.config.profile === undefined)
                    this.host.firstRunNotice(ctx);
                else {
                    const name = this.lastChoice.profile ?? this.config.profile ?? "the configured AWS profile";
                    let message: string;
                    switch (status) {
                        case "timeout":
                            message =
                                "AWS discovery is slow; Bedrock models are not loaded yet. Try again in a moment or run /bedrock refresh.";
                            break;
                        case "credentials":
                            message = `Bedrock: the AWS profile ${name} has no credentials.`;
                            break;
                        case "sso_expired":
                            message = `Bedrock: sign-in expired for the AWS profile ${name}.`;
                            break;
                        case "permission_denied":
                            message = `Bedrock: the AWS profile ${name} was refused by AWS.`;
                            break;
                        case "throttled":
                            message = `Bedrock: AWS is limiting requests for the AWS profile ${name}; wait a minute, then /bedrock refresh.`;
                            break;
                        case "aws_error":
                            message = `Bedrock: AWS had a problem on its side for the AWS profile ${name}; try again later.`;
                            break;
                        case "expired_credentials":
                            message = isSsoProfile(name, this.host.env)
                                ? `Bedrock: sign-in expired for the AWS profile ${name}. Run /bedrock login, then /bedrock refresh.`
                                : `Bedrock: the AWS credentials for the AWS profile ${name} have expired. Refresh the keys, then /bedrock refresh.`;
                            break;
                        case "invalid_credentials":
                            message = `Bedrock: AWS says the keys for the AWS profile ${name} are not valid: they may be revoked or wrong, or a region may not be enabled for the account. Check the keys and the region, then /bedrock refresh.`;
                            break;
                        default:
                            message = `${reason ?? "Bedrock could not load models."} ${discoveryHelp(status)}`;
                    }
                    ctx.ui.notify(message, "warning");
                }
            }
            const updated = this.readModels().available;
            const selected = ctx?.model;
            const selectedGone =
                isOwnModel(selected) && selected !== undefined && !updated.some((model) => model.id === selected.id);
            if (isOwnModel(selected)) {
                const previous = this.models.find((m) => m.id === selected?.id);
                const replacement = updated.find((m) => m.id === selected?.id);
                if (
                    !replacement ||
                    (previous &&
                        (previous.arn !== replacement.arn ||
                            previous.foundationModelId !== replacement.foundationModelId))
                ) {
                    this.host.guard()?.blockUntilChoice();
                }
            }
            const beforeCount = this.settingsBaseline ?? this.models.length;
            this.settingsBaseline = undefined;
            const change = updateModels(this.models, updated);
            if (change.changed) await this.host.registerModels(this);
            // The session may have started or ended across that await; the notices below belong to the current one.
            ctx = this.host.context();
            const guard = this.host.guard();
            if (change.changed && guard?.unresolved() && ctx !== undefined && !this.settingsChanged)
                await guard.restoreSaved(ctx);
            const current = this.catalog.load();
            const problems = current?.errors ?? [];
            const warnings = current?.warnings ?? [];
            const partial = partialDiscovery(current);
            if (
                !quiet &&
                !failureNotice &&
                ctx &&
                (change.added > 0 || change.removed > 0 || problems.length > 0 || warnings.length > 0)
            ) {
                if (warnings.length > 0 || problems.length > 0) {
                    const details =
                        partial === undefined
                            ? [...warnings, problemSummary(problems)]
                            : [`${partial.line}.`, partial.errors, ...partial.warnings];
                    ctx.ui.notify(
                        `Bedrock: ${details.filter((part): part is string => part !== undefined).join(" ")}`,
                        "warning",
                    );
                }
                if (this.settingsChanged && (change.added > 0 || change.removed > 0)) {
                    const left = Math.max(0, beforeCount - this.models.length);
                    const why =
                        status !== "ok"
                            ? `${this.catalog.failure?.() ?? "Bedrock could not load models."} ${discoveryHelp(status)}`
                            : warnings.length > 0
                              ? warnings.join(" ")
                              : problems.length > 0
                                ? (problemSummary(problems) ?? "")
                                : "";
                    ctx.ui.notify(
                        `Bedrock: ${this.models.length} models in /model (${left} left).${why === "" ? "" : ` ${why}`}`,
                        status === "ok" ? "info" : "warning",
                    );
                } else if (change.added > 0) {
                    ctx.ui.notify(
                        `Bedrock: ${change.added} new model${change.added === 1 ? "" : "s"} in /model.`,
                        "info",
                    );
                } else if (change.removed > 0) {
                    ctx.ui.notify(
                        `Bedrock: ${change.removed} model${change.removed === 1 ? "" : "s"} left /model.`,
                        "info",
                    );
                }
                if (selectedGone && selected !== undefined) {
                    if (this.settingsChanged) guard?.suppressWarnings();
                    ctx.ui.notify(
                        this.settingsChanged
                            ? `Bedrock: ${selected.id} is not in the list for the new settings; choose another with /model.`
                            : `Bedrock: ${selected.id} is no longer in your account; choose another with /model.`,
                        "warning",
                    );
                }
            }
            this.settingsChanged = false;
            return status;
        })().finally(() => {
            this.refreshInFlight = undefined;
            this.noticeFailureOnce = false;
        });
        return this.refreshInFlight;
    }

    async refreshForModelSelector(force: boolean, signal?: AbortSignal): Promise<void> {
        // A login or a previous /model press is already refreshing: publish what is loaded now rather than wait for it.
        if (this.refreshInFlight !== undefined) return;
        // Pi gives this call the /model dialog's 15 s signal. Start the refresh and stop waiting when Pi does; the
        // discovery keeps going and the models arrive in the list it already holds.
        const flight = this.refresh(force, false, true);
        if (signal === undefined) {
            const status = await flight;
            if (status !== "ok")
                throw new Error(
                    `${this.catalog.failure?.() ?? "Bedrock could not load models."} ${discoveryHelp(status, this.config.mode)}`,
                );
            return;
        }
        const aborted = new Promise<"aborted">((resolve) => {
            if (signal.aborted) {
                resolve("aborted");
                return;
            }
            signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
        const outcome = await Promise.race([flight, aborted]);
        if (outcome === "aborted") return;
        if (outcome !== "ok")
            throw new Error(
                `${this.catalog.failure?.() ?? "Bedrock could not load models."} ${discoveryHelp(outcome, this.config.mode)}`,
            );
    }

    /** Resolve this preset's AWS profile and record it as the one in force. */
    async resolveProfile(context: ExtensionContext): Promise<ProfileChoice> {
        if (!this.host.options.preserveNativeAuth) {
            // Pi resolves this provider's auth from its credential store; the credential is passed to the provider's
            // resolve, which records /login's env.AWS_PROFILE here. Nothing reads auth.json.
            const registry = (
                context as {
                    modelRegistry?: { getProviderAuth?: (id: string) => Promise<unknown> };
                }
            ).modelRegistry;
            try {
                await registry?.getProviderAuth?.(this.providerId);
            } catch {}
        }
        const choice = await this.profiles.resolve({ signal: this.host.signal() });
        this.config.profile = choice.profile;
        this.lastChoice = choice;
        this.autoProfile =
            choice.ambient === true ||
            choice.source === "default" ||
            choice.source === "AWS_PROFILE" ||
            choice.source === "AWS_DEFAULT_PROFILE";
        this.autoProfileFailed = this.autoProfile && this.models.length === 0;
        return choice;
    }
}
