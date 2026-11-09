// The preflight both sign-in paths share: `/aws-login` and the automatic repair after an expired session only start the
// AWS CLI when the profile `aws configure list-profiles` names is an IAM Identity Center (SSO) profile in the AWS config.
// It reads the config (never the credentials file) and the profile list; the profile list is only asked for when a person
// is waiting, because it costs one CLI start.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ListProfiles, LOGIN_PATH } from "./profile.ts";
import type { Recover } from "./sso.ts";
import { SsoRecoveryError } from "./sso.ts";

/** The AWS CLI's shared config file: `AWS_CONFIG_FILE`, else `~/.aws/config`. */
export function awsConfigFile(env: NodeJS.ProcessEnv = process.env): string {
    return env.AWS_CONFIG_FILE !== undefined && env.AWS_CONFIG_FILE !== ""
        ? env.AWS_CONFIG_FILE
        : join(env.HOME ?? homedir(), ".aws", "config");
}

/** The sections of an AWS config file, keyed `profile:<name>`, `sso-session:<name>` or the bare name. */
export function parseAwsConfig(text: string): Map<string, Map<string, string>> {
    const sections = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
        if (line.startsWith("[") && line.endsWith("]")) {
            const name = line.slice(1, -1).trim();
            const key = name.startsWith("profile ")
                ? `profile:${name.slice("profile ".length).trim()}`
                : name.startsWith("sso-session ")
                  ? `sso-session:${name.slice("sso-session ".length).trim()}`
                  : name;
            current = new Map();
            sections.set(key, current);
            continue;
        }
        const equals = line.indexOf("=");
        if (equals <= 0 || current === undefined) continue;
        current.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
    }
    return sections;
}

/** What is wrong with this profile for an SSO sign-in, or undefined when it is a listed SSO profile. */
export async function profileProblem(
    profile: string,
    options: { list?: ListProfiles; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string | undefined> {
    const env = options.env ?? process.env;
    if (options.list !== undefined) {
        const listed = await options.list(options.signal);
        if (listed === undefined)
            return "Could not list your AWS profiles. Check that the AWS CLI v2 is installed (aws configure list-profiles), then run /aws-login again.";
        if (!listed.includes(profile))
            return `${profile} is not in aws configure list-profiles. Run ${LOGIN_PATH} to choose a profile, or set bedrock.profile.`;
    }
    let text: string;
    try {
        text = readFileSync(awsConfigFile(env), "utf8");
    } catch {
        return `${profile} is not in the AWS config, so it is not an IAM Identity Center (SSO) profile. /aws-login only renews SSO sessions.`;
    }
    const sections = parseAwsConfig(text);
    const section = sections.get(`profile:${profile}`) ?? sections.get(profile);
    if (section === undefined)
        return `${profile} has no profile section in the AWS config, so it is not an IAM Identity Center (SSO) profile. /aws-login only renews SSO sessions.`;
    const session = section.get("sso_session");
    if (session === undefined && section.get("sso_start_url") === undefined)
        return `${profile} is not an IAM Identity Center (SSO) profile. /aws-login only renews SSO sessions; a profile with keys or a role does not need it.`;
    if (session !== undefined && session !== "" && !sections.has(`sso-session:${session}`))
        return `${profile} names the SSO session ${session}, but [sso-session ${session}] is not in the AWS config. Run aws configure sso again.`;
    return undefined;
}

/**
 * Wrap a recovery so both callers share the preflight. A manual `/aws-login` checks the profile list too (the person is
 * waiting, and a wrong name should not start a login); the automatic repair checks the config only, so a slow or missing
 * AWS CLI cannot block it — the CLI itself will report an unknown profile if there is one.
 */
export function checkedRecovery(
    recovery: Recover,
    options: { manualList: ListProfiles; env: NodeJS.ProcessEnv },
): Recover {
    return async (profile, signal, source = "manual") => {
        const problem = await profileProblem(profile, {
            ...(source === "manual" ? { list: options.manualList } : {}),
            env: options.env,
            ...(signal === undefined ? {} : { signal }),
        });
        if (problem !== undefined) throw new SsoRecoveryError("profile", source === "request", problem);
        return recovery(profile, signal, source);
    };
}
