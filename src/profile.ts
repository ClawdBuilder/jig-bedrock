// Where the AWS profile comes from, in one place: the explicit setting, JIG_BEDROCK_PROFILE, the profile chosen by
// /login (Pi's credential for this provider), AWS_PROFILE, AWS_DEFAULT_PROFILE, then the default profile if it exists.
// The name is checked against `aws configure list-profiles`, cached for a minute: a local command, no network, so
// `/model` and the doctor can answer "is this profile real?" without an STS call.
import { execFile } from "node:child_process";
import type { ApiKeyCredential, ProviderAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { profilePattern } from "./config.ts";

export type ProfileSource = "setting" | "env" | "login" | "AWS_PROFILE" | "AWS_DEFAULT_PROFILE" | "default";

/** The profile to use, where it came from, and whether the AWS CLI lists it. `exists` undefined means "not checked". */
export interface ProfileChoice {
    profile?: string;
    source?: ProfileSource;
    exists?: boolean;
    /** Set when the name is not a legal AWS profile name; it is reported, not used. */
    problem?: string;
    /** No profile is configured, but the credential chain has credentials in the environment. */
    ambient?: boolean;
}

export interface ProfileSettings {
    /** `bedrock.profile` from the settings file or Jig's section. */
    setting?: string;
    /** `env` when JIG_BEDROCK_PROFILE supplied the setting; `setting` otherwise. */
    settingSource?: "setting" | "env";
    env?: NodeJS.ProcessEnv;
}

/** `aws configure list-profiles`, or undefined when the AWS CLI cannot answer. */
export type ListProfiles = (signal?: AbortSignal) => Promise<string[] | undefined>;

/** The one line every command says when no profile is configured. */
export const NO_PROFILE =
    "No AWS profile is configured for Bedrock. Run /login and choose Amazon Bedrock (jig-bedrock), or set bedrock.profile.";

export function sourceLabel(source: ProfileSource | undefined): string {
    switch (source) {
        case "setting":
            return "bedrock.profile";
        case "env":
            return "JIG_BEDROCK_PROFILE";
        case "login":
            return "/login";
        case "AWS_PROFILE":
            return "AWS_PROFILE";
        case "AWS_DEFAULT_PROFILE":
            return "AWS_DEFAULT_PROFILE";
        case "default":
            return "the default profile";
        default:
            return "unknown";
    }
}

export function missingProfileNotice(choice: Pick<ProfileChoice, "profile" | "source">): string {
    return `${choice.profile} (from ${sourceLabel(choice.source)}) is not in aws configure list-profiles. Run /login to choose a profile, or fix the name.`;
}

/** Credentials the SDK chain can use without a profile; an instance role needs a call, so it is not checked here. */
export function hasAmbientCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
    if (typeof env.AWS_ACCESS_KEY_ID === "string" && typeof env.AWS_SECRET_ACCESS_KEY === "string") return true;
    if (typeof env.AWS_WEB_IDENTITY_TOKEN_FILE === "string" && env.AWS_WEB_IDENTITY_TOKEN_FILE !== "") return true;
    return (
        (typeof env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI === "string" &&
            env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== "") ||
        (typeof env.AWS_CONTAINER_CREDENTIALS_FULL_URI === "string" && env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== "")
    );
}

/** Runs the AWS CLI's local profile listing; its output is only names, never a value. */
export function createListProfiles(env: NodeJS.ProcessEnv = process.env): ListProfiles {
    return (signal) =>
        new Promise((resolve) => {
            execFile(
                "aws",
                ["configure", "list-profiles"],
                { encoding: "utf8", timeout: 2000, maxBuffer: 65_536, env, signal },
                (error, stdout) => {
                    if (error) {
                        resolve(undefined);
                        return;
                    }
                    resolve(
                        stdout
                            .split("\n")
                            .map((line) => line.trim())
                            .filter((line) => line !== ""),
                    );
                },
            );
        });
}

export interface ResolverOptions {
    settings: ProfileSettings;
    listProfiles?: ListProfiles;
    now?: () => number;
    /** How long a listing is reused. */
    cacheMs?: number;
}

export class ProfileResolver {
    private readonly settings: ProfileSettings;
    private readonly list: ListProfiles;
    private readonly now: () => number;
    private readonly cacheMs: number;
    private cached?: { at: number; profiles: string[] | undefined };
    /** The profile Pi stores in the /login credential; set whenever the provider's resolve sees it. */
    stored?: string;

    constructor(options: ResolverOptions) {
        this.settings = options.settings;
        this.list = options.listProfiles ?? createListProfiles(options.settings.env ?? process.env);
        this.now = options.now ?? Date.now;
        this.cacheMs = options.cacheMs ?? 60_000;
    }

    invalidate(): void {
        this.cached = undefined;
    }

    /** The candidates in order. The default profile is not here: it is tried only when the list shows it exists. */
    candidates(stored = this.stored): Array<{ profile: string; source: ProfileSource }> {
        const env = this.settings.env ?? {};
        const candidates: Array<{ profile: string; source: ProfileSource }> = [];
        if (typeof this.settings.setting === "string" && this.settings.setting.trim() !== "") {
            candidates.push({
                profile: this.settings.setting.trim(),
                source: this.settings.settingSource ?? "setting",
            });
        }
        if (typeof stored === "string" && stored.trim() !== "")
            candidates.push({ profile: stored.trim(), source: "login" });
        if (typeof env.AWS_PROFILE === "string" && env.AWS_PROFILE.trim() !== "")
            candidates.push({ profile: env.AWS_PROFILE.trim(), source: "AWS_PROFILE" });
        if (typeof env.AWS_DEFAULT_PROFILE === "string" && env.AWS_DEFAULT_PROFILE.trim() !== "")
            candidates.push({ profile: env.AWS_DEFAULT_PROFILE.trim(), source: "AWS_DEFAULT_PROFILE" });
        return candidates;
    }

    /**
     * The profile the provider should use. An explicit choice (setting, credential, environment) is never replaced by a
     * lower one, even when it is missing: the person needs to see which choice is wrong.
     */
    async resolve(options: { stored?: string; signal?: AbortSignal } = {}): Promise<ProfileChoice> {
        if (options.stored !== undefined) this.stored = options.stored;
        const [first] = this.candidates(options.stored);
        if (first !== undefined) {
            if (!profilePattern.test(first.profile)) {
                return {
                    profile: first.profile,
                    source: first.source,
                    exists: false,
                    problem: `${first.profile} is not a legal AWS profile name`,
                };
            }
            return {
                profile: first.profile,
                source: first.source,
                exists: await this.has(first.profile, options.signal),
            };
        }
        if (await this.has("default", options.signal)) return { profile: "default", source: "default", exists: true };
        if (hasAmbientCredentials(this.settings.env ?? process.env)) return { ambient: true };
        return {};
    }

    /** Whether `aws configure list-profiles` names this profile. Undefined when the AWS CLI could not answer. */
    async has(profile: string, signal?: AbortSignal): Promise<boolean | undefined> {
        const profiles = await this.profiles(signal);
        return profiles === undefined ? undefined : profiles.includes(profile);
    }

    /** The cached listing, for /login's picker. */
    listing(signal?: AbortSignal): Promise<string[] | undefined> {
        return this.profiles(signal);
    }

    private async profiles(signal?: AbortSignal): Promise<string[] | undefined> {
        if (this.cached !== undefined && this.now() - this.cached.at < this.cacheMs) return this.cached.profiles;
        const profiles = await this.list(signal);
        this.cached = { at: this.now(), profiles };
        return profiles;
    }
}

/** The prompts /login asks: a profile from the CLI's list, or a typed name. It never asks for a secret. */
export async function loginWithProfile(
    interaction: ProviderAuthInteraction,
    listProfiles: ListProfiles,
): Promise<ApiKeyCredential> {
    interaction.signal.throwIfAborted();
    const listed = await listProfiles(interaction.signal);
    interaction.signal.throwIfAborted();
    let name: string;
    if (listed !== undefined && listed.length > 0) {
        const answer = await interaction.prompt({
            type: "select",
            message: "Which AWS profile should Bedrock use?",
            options: [
                ...listed.map((profile) => ({ id: `profile:${profile}`, label: profile })),
                { id: "type", label: "Type another profile name" },
            ],
        });
        interaction.signal.throwIfAborted();
        name =
            answer === "type"
                ? await interaction.prompt({ type: "text", message: "AWS profile name", placeholder: "my-profile" })
                : answer.replace(/^profile:/, "");
    } else {
        name = await interaction.prompt({
            type: "text",
            message: "AWS profile name (aws configure sso or aws configure makes one)",
            placeholder: "my-profile",
        });
    }
    name = name.trim();
    if (!profilePattern.test(name)) throw new Error("That is not an AWS profile name.");
    if (listed !== undefined && !listed.includes(name))
        interaction.notify({
            type: "info",
            message: `${name} is not in aws configure list-profiles. It must exist before Bedrock can load models.`,
        });
    return { type: "api_key", env: { AWS_PROFILE: name } };
}

/** The provider auth: one method, an AWS profile; the credential holds only the name, in env.AWS_PROFILE. */
export function createProfileAuth(resolver: ProfileResolver): ProviderAuth {
    return {
        apiKey: {
            name: "AWS profile",
            login: (interaction) => loginWithProfile(interaction, (signal) => resolver.listing(signal)),
            // Pi asks this before each request and for /model; the listing is cached, so it is a local check.
            resolve: async ({ credential, signal }) => {
                const choice = await resolver.resolve({ stored: credential?.env?.AWS_PROFILE, signal });
                if (choice.ambient === true) return { auth: {}, source: "AWS credential chain" };
                if (!choice.profile || choice.problem !== undefined || choice.exists === false) return undefined;
                return { auth: {}, env: { AWS_PROFILE: choice.profile }, source: sourceLabel(choice.source) };
            },
        },
    };
}
