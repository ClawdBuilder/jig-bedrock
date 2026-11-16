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
    new Promise((resolve, reject) => {
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
            (error) =>
                (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? reject(error) : resolve(error === null),
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
    let missing = false;
    try {
        ok = await run(profile, env, options.timeoutMs ?? 15_000, options.signal);
    } catch (error) {
        missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    }
    if (ok) return { ok: true };
    if (missing)
        return {
            ok: false,
            message: "the aws command was not found. Install AWS CLI v2, then try again.",
        };
    return {
        ok: false,
        message: `AWS did not answer for ${profile === undefined ? "the credential chain" : profile}. Check the profile and your network access, then try again.`,
    };
}

/** The profile whose SSO session must be renewed: the profile itself, or one source_profile level. */
export function ssoSignInTarget(
    profile: string,
    env: NodeJS.ProcessEnv = process.env,
): { target: string; via?: string } | { problem: string; keys?: boolean } {
    const text = readConfig(env);
    if (text === undefined) return { problem: `${profile} is not in the AWS config.` };
    const sections = parseAwsConfig(text);
    const section = sections.get(`profile:${profile}`) ?? sections.get(profile);
    if (section === undefined) return { problem: `${profile} has no profile section in the AWS config.` };
    if (section.get("sso_session") !== undefined || section.get("sso_start_url") !== undefined)
        return { target: profile };
    const source = section.get("source_profile");
    if (source === undefined || source === "")
        return {
            problem: `${profile} signs in with its own keys or role, not an IAM Identity Center (SSO) session. Check it with "aws sts get-caller-identity --profile ${profile}", or use /login to choose another AWS profile.`,
            keys: true,
        };
    if (source === profile)
        return { problem: `${profile} names itself as source_profile; fix the loop in the AWS config.` };
    if (!isSsoProfile(source, env))
        return {
            problem: `${profile} uses source_profile ${source}, which is not an IAM Identity Center (SSO) profile. Fix the AWS config or use /login to choose another AWS profile.`,
            keys: true,
        };
    return { target: source, via: profile };
}

/** Whether /bedrock login will refuse this profile: it signs in with keys, or a role over a keys source_profile. */
export function signsInWithKeys(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const target = ssoSignInTarget(profile, env);
    return !("target" in target) && target.keys === true;
}

/**
 * The one next step for a profile /bedrock login cannot renew. `then` is the command that checks the fixed profile, so the
 * doctor and the login command say the same words.
 */
export function keysAdviceNext(profile: string, then: string): string {
    return `Next: check the keys or role for ${profile} with "aws sts get-caller-identity --profile ${profile}", or refresh the keys, then ${then}`;
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
            return `${profile} is not in aws configure list-profiles. Run ${LOGIN_PATH} to choose a profile, or set profile.`;
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
        return `${profile} has no profile section in the AWS config. /bedrock login only renews IAM Identity Center (SSO) sessions.`;
    const session = section.get("sso_session");
    if (session === undefined && section.get("sso_start_url") === undefined) {
        const target = ssoSignInTarget(profile, env);
        if ("problem" in target) return target.problem;
        if (target.via !== undefined) return undefined;
        return `${profile} is not an IAM Identity Center (SSO) profile.`;
    }
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
        const target = ssoSignInTarget(profile, options.env);
        if ("problem" in target) throw new SsoRecoveryError("profile", source === "request", target.problem);
        const problem = await profileProblem(target.target, {
            ...(source === "manual" ? { list: options.manualList } : {}),
            env: options.env,
            ...(signal === undefined ? {} : { signal }),
        });
        if (problem !== undefined) throw new SsoRecoveryError("profile", source === "request", problem);
        profile = target.target;
        return recovery(profile, signal, source);
    };
}
