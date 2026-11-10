// The Bedrock provider's settings: bedrock.json, over the package defaults, over which environment
// variables win. Diagnostics name fields and never echo configuration values or parser output.
//
//   team               your exact AWS "Team" tag value: the inference profiles that carry it (and Active=true) are the models
//   profile            the AWS profile to sign in with; absent means /login's choice, then AWS_PROFILE, then the
//                      default profile if AWS lists it (no placeholder)
//   regions            where to look for profiles (default us-east-1)
//   monthlyBudgetUsd   a figure to show in the footer next to the month's spend; not an AWS limit (optional)
//   ssoLoginCommand    the argv of the login, with {profile} for the profile (default aws sso login --profile {profile})
//   signInAtStart      sign in when Pi starts and the SSO session has expired, instead of at the first failed request (default false)
//   browser            the program that opens the sign-in address, as BROWSER for the login (optional; under WSL the Windows browser)
//   api                the Bedrock route: messages, the Anthropic Messages route (default), or converse, the older route
//   converseModels     short model ids (claude-opus-5) that stay on Converse
//   messagesModels     short model ids that go on Messages even where Pi does not list tool changes for them
//   debug              write a request log (no prompts, no credentials) to the state folder's debug.log (default false)
//
// Environment variables override the settings: JIG_BEDROCK_TEAM, JIG_BEDROCK_PROFILE, JIG_BEDROCK_REGIONS (comma
// separated); JIG_BEDROCK_DEBUG=1 turns the debug log on.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Check } from "./check.ts";
import { isObject, knownKeys } from "./check.ts";

export interface ResolvedConfig {
    team?: string;
    tagKey?: string;
    tagValue?: string;
    activeTagKey?: string;
    activeTagValue?: string;
    /** Explicit inference-profile ARNs or ids; when nonempty, no tag or system search runs. */
    profiles?: string[];
    /** Derived: explicit, tag or system. */
    mode?: "explicit" | "tag" | "system";
    /** Unset when the person has not configured one; the resolver in profile.ts fills it in. */
    profile?: string;
    /** Where an explicitly configured profile came from, for diagnostics. */
    profileSource?: "setting" | "env";
    regions: string[];
    /** Optional argv that prints { month, spentUsd }; never a shell. */
    spendCommand?: string[];
    monthlyBudgetUsd?: number;
    ssoLoginCommand: string[];
    signInAtStart: boolean;
    browser?: string;
    /** Set by loadConfig; a hand-written fixture may leave it out, and the provider then uses messages. */
    api?: BedrockApi;
    /** Short model ids that stay on Converse, whatever the model list says. */
    converseModels?: string[];
    /** Short model ids that go on Messages, for a model newer than the installed Pi knows. */
    messagesModels?: string[];
    /** The debug log is on (the setting, or JIG_BEDROCK_DEBUG=1); a hand-written fixture may leave it out. */
    debug?: boolean;
    agentDir?: string;
}

/** The two ways to reach the same models: the Anthropic Messages route, or the older Converse route. */
export type BedrockApi = "messages" | "converse";
export type ConfigResult =
    | { config: ResolvedConfig; error?: never; unknown?: string[]; warning?: string }
    | { config?: never; error: string; unknown?: never; warning?: never };

export const profilePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
/** A full path, or a bare program name: never a path relative to the folder Pi happens to be in, and no arguments. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a browser path may not contain control characters
const browserPattern = /^(?:\/[^\s\x00-\x1f\x7f]{1,4095}|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/;
/** Every setting of the `bedrock` section. A key that is not one of these is an error. */
export const FIELDS = [
    "team",
    "tagKey",
    "tagValue",
    "activeTagKey",
    "activeTagValue",
    "profiles",
    "profile",
    "regions",
    "spendCommand",
    "monthlyBudgetUsd",
    "ssoLoginCommand",
    "signInAtStart",
    "browser",
    "api",
    "converseModels",
    "messagesModels",
    "debug",
] as const;

export const DEFAULTS = {
    regions: ["us-east-1"],
    ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
    signInAtStart: false,
    api: "messages" as BedrockApi,
    debug: false,
};

/** A short model id: Claude's name and version, as in `claude-opus-5` or `claude-sonnet-5-5`. */
const shortModelPattern = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: config values reject control characters
const control = /[\x00-\x1f\x7f]/;

/** The problems with a configuration, one message each, each naming its field. Empty when it is fine. */
export function problemsOf(c: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const {
        team,
        tagKey,
        tagValue,
        activeTagKey,
        activeTagValue,
        profiles,
        profile,
        regions,
        spendCommand,
        monthlyBudgetUsd,
        ssoLoginCommand,
        signInAtStart,
        browser,
        api,
        converseModels,
        messagesModels,
        debug,
    } = c;
    if (
        team !== undefined &&
        (typeof team !== "string" || team.trim() === "" || team.length > 256 || control.test(team))
    ) {
        problems.push("bedrock.team must be your exact AWS tag value (1-256 characters, no control characters)");
    }
    if (team !== undefined && (tagKey !== undefined || tagValue !== undefined))
        problems.push("bedrock.team cannot be combined with bedrock.tagKey or bedrock.tagValue");
    if ((tagKey === undefined) !== (tagValue === undefined))
        problems.push("bedrock.tagKey and bedrock.tagValue must be set together");
    if ((activeTagKey === undefined) !== (activeTagValue === undefined))
        problems.push("bedrock.activeTagKey and bedrock.activeTagValue must be set together");
    for (const [name, value] of [
        ["tagKey", tagKey],
        ["tagValue", tagValue],
        ["activeTagKey", activeTagKey],
        ["activeTagValue", activeTagValue],
    ] as const)
        if (
            value !== undefined &&
            (typeof value !== "string" || value.trim() === "" || value.length > 256 || control.test(value))
        )
            problems.push(`bedrock.${name} must be a tag name or value of 1-256 characters`);
    if (
        profiles !== undefined &&
        (!Array.isArray(profiles) ||
            profiles.length === 0 ||
            profiles.length > 256 ||
            profiles.some(
                (value) =>
                    typeof value !== "string" ||
                    value.trim() === "" ||
                    value.length > 2048 ||
                    value.startsWith("-") ||
                    !/^[A-Za-z0-9._:/-]+$/.test(value) ||
                    control.test(value),
            ) ||
            new Set(profiles).size !== profiles.length)
    ) {
        problems.push("bedrock.profiles must be a nonempty list of up to 256 unique inference-profile ARNs or ids");
    }
    if (profile !== undefined && (typeof profile !== "string" || !profilePattern.test(profile))) {
        problems.push(
            "bedrock.profile must be an AWS profile name: 1-128 letters, digits, underscores, dots or hyphens, starting with a letter or digit",
        );
    }
    if (
        !Array.isArray(regions) ||
        regions.length === 0 ||
        regions.length > 16 ||
        regions.some((region) => typeof region !== "string" || !regionPattern.test(region)) ||
        new Set(regions).size !== regions.length
    ) {
        problems.push("bedrock.regions must contain 1-16 unique AWS region names");
    }
    if (
        spendCommand !== undefined &&
        (!Array.isArray(spendCommand) ||
            spendCommand.length === 0 ||
            spendCommand.length > 64 ||
            spendCommand.some(
                (part) => typeof part !== "string" || part === "" || part.length > 4096 || control.test(part),
            ))
    ) {
        problems.push("bedrock.spendCommand must be a nonempty argv array of strings, without a shell");
    }
    if (
        monthlyBudgetUsd !== undefined &&
        (typeof monthlyBudgetUsd !== "number" || !Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0)
    ) {
        problems.push("bedrock.monthlyBudgetUsd must be a positive finite number, or omitted");
    }
    if (
        !Array.isArray(ssoLoginCommand) ||
        ssoLoginCommand.length === 0 ||
        ssoLoginCommand.length > 64 ||
        ssoLoginCommand.some(
            (part) =>
                typeof part !== "string" ||
                part === "" ||
                part.length > 4096 ||
                control.test(part) ||
                /[{}]/.test(part.replaceAll("{profile}", "")),
        ) ||
        String(ssoLoginCommand[0]).includes("{profile}")
    ) {
        problems.push("bedrock.ssoLoginCommand must be an argv array; only {profile} is supported in arguments");
    }
    if (typeof signInAtStart !== "boolean") problems.push("bedrock.signInAtStart must be true or false");
    if (typeof debug !== "boolean") problems.push("bedrock.debug must be true or false");
    if (browser !== undefined && (typeof browser !== "string" || !browserPattern.test(browser))) {
        problems.push(
            "bedrock.browser must be the full path of a program that opens an address, or the name of one on the PATH (no spaces or arguments)",
        );
    }
    if (api !== undefined && api !== "messages" && api !== "converse") {
        problems.push('bedrock.api must be "messages" (the Anthropic Messages route) or "converse" (the older route)');
    }
    for (const [name, value] of [
        ["converseModels", converseModels],
        ["messagesModels", messagesModels],
    ] as const)
        if (
            value !== undefined &&
            (!Array.isArray(value) ||
                value.length > 64 ||
                value.some((id) => typeof id !== "string" || id.length > 64 || !shortModelPattern.test(id)) ||
                new Set(value).size !== value.length)
        )
            problems.push(
                `bedrock.${name} must be a list of up to 64 unique short model ids such as claude-opus-5 (no region, no provider prefix, no version suffix)`,
            );
    if (
        Array.isArray(converseModels) &&
        Array.isArray(messagesModels) &&
        converseModels.some((id) => messagesModels.includes(id))
    )
        problems.push("bedrock.converseModels and bedrock.messagesModels name the same model; choose one route");
    return problems;
}

/** Validate a settings object; the package defaults fill what is left out. */
export const checkBedrock: Check = (raw, errors) => {
    if (!isObject(raw)) {
        errors.push("bedrock must be an object");
        return;
    }
    knownKeys(raw, FIELDS, "bedrock", errors);
    errors.push(...problemsOf({ ...DEFAULTS, ...raw }));
};

/** The messages for a settings object, empty when it is fine. */
export function validateBedrock(raw: unknown): string[] {
    const errors: string[] = [];
    checkBedrock(raw, errors);
    return errors;
}

/**
 * The settings as the provider uses them: the package defaults, then `raw` (the `bedrock` section, or undefined when
 * there is none), then the environment variables.
 */
export function loadConfig(
    options: { raw: Record<string, unknown> | undefined; env?: NodeJS.ProcessEnv; agentDir?: string } = {
        raw: undefined,
    },
): ConfigResult {
    const env = options.env ?? process.env;
    const agentDir = options.agentDir ?? (env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"));
    const raw = options.raw ?? {};
    const unknown = Object.keys(raw).filter((key) => !(FIELDS as readonly string[]).includes(key));
    const known = Object.fromEntries(
        Object.entries(raw).filter(([key]) => (FIELDS as readonly string[]).includes(key)),
    );
    const c: Record<string, unknown> = { ...DEFAULTS, ...known, agentDir };
    if (env.JIG_BEDROCK_TEAM !== undefined) c.team = env.JIG_BEDROCK_TEAM;
    if (env.JIG_BEDROCK_TAG_KEY !== undefined) c.tagKey = env.JIG_BEDROCK_TAG_KEY;
    if (env.JIG_BEDROCK_TAG_VALUE !== undefined) c.tagValue = env.JIG_BEDROCK_TAG_VALUE;
    let profileSource: "setting" | "env" | undefined =
        typeof c.profile === "string" && c.profile !== "" ? "setting" : undefined;
    if (env.JIG_BEDROCK_PROFILE !== undefined) {
        c.profile = env.JIG_BEDROCK_PROFILE;
        profileSource = "env";
    }
    if (env.JIG_BEDROCK_DEBUG === "1") c.debug = true;
    if (env.JIG_BEDROCK_REGIONS !== undefined)
        c.regions = env.JIG_BEDROCK_REGIONS.split(",").map((region) => region.trim());
    if (typeof c.profile === "string" && c.profile.trim() === "") {
        delete c.profile;
        profileSource = undefined;
    }
    const [problem] = problemsOf(c);
    if (problem !== undefined) return { error: `${problem}.` };
    if (typeof c.team === "string") {
        c.tagKey = "Team";
        c.tagValue = c.team;
        c.activeTagKey = "Active";
        c.activeTagValue = "true";
    }
    const team = typeof c.team === "string" && c.team !== "" ? c.team : undefined;
    const tagValue = typeof c.tagValue === "string" && c.tagValue !== "" ? c.tagValue : team;
    const explicit = Array.isArray(c.profiles) && c.profiles.length > 0;
    c.team = team;
    c.tagValue = tagValue;
    if (profileSource !== undefined) c.profileSource = profileSource;
    c.mode = explicit ? "explicit" : tagValue !== undefined || c.tagKey !== undefined ? "tag" : "system";
    // Legacy team settings keep Active=true unless the user sets an active tag key.
    if (c.mode === "tag" && c.activeTagKey === undefined && team !== undefined)
        c.activeTagValue = c.activeTagValue ?? "true";
    if (c.mode !== "tag") {
        delete c.tagKey;
        delete c.activeTagKey;
        delete c.activeTagValue;
    }
    return { config: c as unknown as ResolvedConfig, ...(unknown.length === 0 ? {} : { unknown }) };
}
