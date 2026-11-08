// Is the profile's AWS SSO session still good? Answered the way Pi's Bedrock provider will resolve it: through the AWS SDK's node
// credential chain, not the AWS CLI, whose cached role credentials outlive an expired SSO session. Based on the older
// bin/aws-sso-check.ts. The answer is one word and never a credential: the SDK's result is thrown away, and the token cache is
// read for its expiry time alone.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CredentialProvider } from "./pi-host.ts";
import { findPiHost, loadCredentialProvider } from "./pi-host.ts";

/** `ok`: the credentials resolve. `sign-in`: the SSO session has expired. `error`: the check itself could not tell. */
export type SsoState = "ok" | "sign-in" | "error";

/** The SDK's credential errors that mean "run aws sso login": its SSO token and credential providers all end theirs with that hint. */
export function classify(error: unknown): SsoState {
    const text = error instanceof Error ? error.message : String(error);
    return /aws sso login/i.test(text) || /^Token is expired/.test(text) ? "sign-in" : "error";
}

/** The SSO session name (or legacy start URL) a profile signs in with, read from the AWS config text. */
export function ssoKey(config: string, profile: string): string | undefined {
    let section = "";
    let key: string | undefined;
    for (const line of config.split(/\r?\n/)) {
        const header = /^\s*\[(.+)\]\s*$/.exec(line);
        if (header) {
            section = (header[1] ?? "").trim();
            continue;
        }
        if (section !== `profile ${profile}` && !(profile === "default" && section === "default")) continue;
        const pair = /^\s*(sso_session|sso_start_url)\s*=\s*(\S+)/.exec(line);
        if (pair && (pair[1] === "sso_session" || key === undefined)) key = pair[2];
    }
    return key;
}

/** True when the cached SSO token stays valid for `marginMs` more: then the SDK needs no sign-in and no network call. */
export function tokenFresh(cache: string, now: number, marginMs = 15 * 60_000): boolean {
    try {
        const expires = Date.parse((JSON.parse(cache) as { expiresAt?: string }).expiresAt ?? "");
        return Number.isFinite(expires) && expires - now > marginMs;
    } catch {
        return false;
    }
}

/** The parts of the machine the check reads, which a test replaces. */
export interface SsoCheckDeps {
    env: NodeJS.ProcessEnv;
    home: string;
    /** The text of a file; throws when it cannot be read. */
    readText(file: string): string;
    now(): number;
    /** The SDK's `defaultProvider`, from Pi's install. Throws when it cannot be loaded. */
    credentialProvider(): CredentialProvider;
    /** How long the SDK may take before the answer is `error`. */
    timeoutMs: number;
}

export function systemSsoDeps(env: NodeJS.ProcessEnv = process.env): SsoCheckDeps {
    return {
        env,
        home: homedir(),
        readText: (file) => readFileSync(file, "utf8"),
        now: Date.now,
        credentialProvider: () => loadCredentialProvider(findPiHost(env)),
        timeoutMs: 10_000,
    };
}

/** A fresh cached token means the profile is signed in, found by two small file reads and no SDK. */
function cachedTokenFresh(profile: string, deps: SsoCheckDeps): boolean {
    try {
        const config = deps.readText(deps.env.AWS_CONFIG_FILE || path.join(deps.home, ".aws/config"));
        const key = ssoKey(config, profile);
        if (!key) return false;
        const file = path.join(deps.home, ".aws/sso/cache", `${createHash("sha1").update(key).digest("hex")}.json`);
        return tokenFresh(deps.readText(file), deps.now());
    } catch {
        return false;
    }
}

/** `work`, or a rejection as soon as `signal` fires, whether or not `work` listens to it. `work`'s own failure is always observed. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const stop = () => reject(new Error("timed out or cancelled"));
        if (signal.aborted) stop();
        signal.addEventListener("abort", stop, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
}

/** Checks `profile`. Never throws, and never returns or keeps anything of a credential. */
export async function checkSso(
    profile: string,
    deps: SsoCheckDeps = systemSsoDeps(),
    signal?: AbortSignal,
): Promise<SsoState> {
    // The fast path: a cached token that stays valid needs no network check and no SDK.
    if (cachedTokenFresh(profile, deps)) return "ok";
    const limit = AbortSignal.timeout(deps.timeoutMs);
    try {
        // The SDK's answer is dropped: only whether it resolved matters.
        await until(deps.credentialProvider()({ profile })(), signal ? AbortSignal.any([signal, limit]) : limit);
        return "ok";
    } catch (error) {
        return classify(error);
    }
}
