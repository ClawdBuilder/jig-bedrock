// The preflight both sign-in paths share: `/bedrock login` and the automatic repair after an expired session only start the
// AWS CLI when the profile is an IAM Identity Center (SSO) profile in the AWS config. It reads the config (never the
// credentials file) and, when a person is waiting, the profile list, so a wrong name does not start a login.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { awsConfigFile, parseAwsConfig } from "./aws-config-read.ts";
import { type ListProfiles, LOGIN_PATH } from "./profile.ts";
import type { Recover } from "./sso.ts";
import { SsoRecoveryError } from "./sso.ts";

// They moved to aws-config-read.ts; the old import path still answers.
export { awsConfigFile, parseAwsConfig };

function readConfig(env: NodeJS.ProcessEnv): string | undefined {
    try {
        return readFileSync(awsConfigFile(env), "utf8");
    } catch {
        return undefined;
    }
}

/** Whether the AWS config gives this profile an IAM Identity Center section (modern or legacy). */
export function isSsoProfile(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const text = readConfig(env);
    if (text === undefined) return false;
    const sections = parseAwsConfig(text);
    const section = sections.get(`profile:${profile}`) ?? sections.get(profile);
    return section?.get("sso_session") !== undefined || section?.get("sso_start_url") !== undefined;
}

/** One `aws sts get-caller-identity` call: does this profile (or the credential chain) answer? */
export type StsRun = (
    profile: string | undefined,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal?: AbortSignal,
) => Promise<boolean>;

export const runStsIdentity: StsRun = (profile, env, timeoutMs, signal) =>
    new Promise((resolve) => {
        execFile(
            "aws",
            [
                "sts",
                "get-caller-identity",
                "--output",
                "json",
                ...(profile === undefined ? [] : ["--profile", profile]),
            ],
            { encoding: "utf8", timeout: timeoutMs, maxBuffer: 65_536, env, signal },
            (error) => resolve(error === null),
        );
    });

export type VerifyResult = { ok: true } | { ok: false; message: string };

/** The documented cheap check that a profile or the ambient chain answers; the output is never shown. */
export async function verifyAwsProfile(
    profile: string | undefined,
    options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; run?: StsRun; timeoutMs?: number } = {},
): Promise<VerifyResult> {
    const env = options.env ?? process.env;
    const run = options.run ?? runStsIdentity;
    let ok = false;
    try {
        ok = await run(profile, env, options.timeoutMs ?? 15_000, options.signal);
    } catch {
        ok = false;
    }
    if (ok) return { ok: true };
    return {
        ok: false,
        message: `AWS did not answer for ${profile === undefined ? "the credential chain" : profile}. Check the profile and your network access, then try again.`,
    };
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
            return "Could not list your AWS profiles. Check that the AWS CLI v2 is installed (aws configure list-profiles), then run /bedrock login again.";
        if (!listed.includes(profile))
            return `${profile} is not in aws configure list-profiles. Run ${LOGIN_PATH} to choose a profile, or set bedrock.profile.`;
    }
    let text: string;
    try {
        text = readFileSync(awsConfigFile(env), "utf8");
    } catch {
        return `${profile} is not in the AWS config, so it is not an IAM Identity Center (SSO) profile. /bedrock login only renews SSO sessions.`;
    }
    const sections = parseAwsConfig(text);
    const section = sections.get(`profile:${profile}`) ?? sections.get(profile);
    if (section === undefined)
        return `${profile} has no profile section in the AWS config, so it is not an IAM Identity Center (SSO) profile. /bedrock login only renews SSO sessions.`;
    const session = section.get("sso_session");
    if (session === undefined && section.get("sso_start_url") === undefined)
        return `${profile} is not an IAM Identity Center (SSO) profile. /bedrock login only renews SSO sessions; a profile with keys or a role does not need it.`;
    if (session !== undefined && session !== "" && !sections.has(`sso-session:${session}`))
        return `${profile} names the SSO session ${session}, but [sso-session ${session}] is not in the AWS config. Run aws configure sso again.`;
    return undefined;
}

/**
 * Wrap a recovery so both callers share the preflight. A manual `/bedrock login` checks the profile list too (the person is
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
