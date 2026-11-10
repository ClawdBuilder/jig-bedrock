import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicCache } from "./cache.ts";
import { boundedRegular } from "./catalog.ts";
import { profilePattern, type ResolvedConfig } from "./config.ts";
import { type Recover, SsoRecoveryError, shareRecovery } from "./sso.ts";
import { loginEnvironment, systemWsl, type WslDeps } from "./wsl.ts";
/**
 * Never create an inherited system runtime path or repair unrelated permissions. The home folder, `.local` and `state` are
 * the user's own: a link there (a state folder on another disk) is followed. From `jig-bedrock` down, a link is refused.
 */
export function ssoRuntime(env: NodeJS.ProcessEnv = process.env): string {
    const safe = (path: string, privateMode = false, followLink = false) => {
        try {
            const meta = followLink ? statSync(path) : lstatSync(path);
            return (
                meta.isDirectory() &&
                !meta.isSymbolicLink() &&
                meta.uid === process.getuid?.() &&
                (meta.mode & (privateMode ? 0o077 : 0o022)) === 0
            );
        } catch {
            return false;
        }
    };
    if (env.XDG_RUNTIME_DIR?.startsWith("/") && safe(env.XDG_RUNTIME_DIR, true)) return env.XDG_RUNTIME_DIR;
    const home = env.HOME;
    if (!home?.startsWith("/") || !safe(home, false, true)) throw new SsoRecoveryError("runtime");
    let path = home;
    for (const component of [".local", "state", "jig-bedrock", "sso-runtime"]) {
        path = join(path, component);
        try {
            mkdirSync(path, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SsoRecoveryError("runtime");
        }
        if (!safe(path, false, component === ".local" || component === "state")) throw new SsoRecoveryError("runtime");
    }
    if (!safe(path, true)) throw new SsoRecoveryError("runtime");
    return path;
}
/** What a test replaces in the sign-in: the program that starts the login, the lock, the time, the environment, WSL, the notices. */
export interface RecoveryOptions {
    /** How the login program is started. */
    start?: typeof spawn;
    /** The lock file, instead of one in the private runtime folder. */
    lock?: string;
    timeoutMs?: number;
    /** The environment the login starts from (default: Pi's own, read when the login starts). */
    env?: NodeJS.ProcessEnv;
    wsl?: WslDeps;
    /** Where the one-line notice of a repair goes (see wsl.ts). */
    say?: (line: string) => void;
}

export function createRecovery(config: ResolvedConfig, options: RecoveryOptions = {}): Recover {
    const { start = spawn, lock: explicitLock, timeoutMs = 300_000, wsl = systemWsl, say = () => {} } = options;
    return shareRecovery(async (profile, signal) => {
        if (!profilePattern.test(profile)) throw new Error("Invalid AWS profile");
        const runtime = explicitLock ? undefined : ssoRuntime();
        const lock = explicitLock ?? join(runtime!, "bedrock-sso.lock");
        const deadline = Date.now() + timeoutMs;
        let waited: string | undefined;
        const token = randomUUID();
        while (true) {
            signal?.throwIfAborted();
            if (Date.now() >= deadline) throw new SsoRecoveryError("timeout");
            try {
                const fd = openSync(lock, "wx", 0o600);
                writeFileSync(fd, JSON.stringify({ pid: process.pid, profile, token }));
                closeSync(fd);
                break;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SsoRecoveryError("runtime");
                try {
                    const owner = JSON.parse(boundedRegular(lock, 1024, true) || "{}");
                    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid lock");
                    try {
                        process.kill(owner.pid, 0);
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                            unlinkSync(lock);
                            continue;
                        }
                    }
                    waited = owner.profile === profile && typeof owner.token === "string" ? owner.token : undefined;
                } catch {
                    try {
                        const meta = lstatSync(lock);
                        if (!meta.isFile() || meta.isSymbolicLink()) throw new SsoRecoveryError("runtime");
                        if (Date.now() - meta.mtimeMs > timeoutMs + 1000) {
                            unlinkSync(lock);
                            continue;
                        }
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                        throw error;
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
                // A completed same-profile login is reused by waiting sessions.
                try {
                    lstatSync(lock);
                } catch {
                    if (waited) {
                        signal?.throwIfAborted();
                        try {
                            const result = JSON.parse(boundedRegular(`${lock}.result`, 1024, true) || "{}");
                            if (result.token === waited && result.ok === true) return;
                        } catch {}
                        throw new Error("Shared SSO login did not complete; run /aws-login");
                    }
                }
            }
        }
        let succeeded = false;
        try {
            // The login's environment: Pi's own, the private runtime folder, and on WSL a browser that opens and an interop
            // socket that answers (wsl.ts). The probe takes up to two seconds, under the lock, and only when a login starts.
            const login = await loginEnvironment(
                { browser: config.browser },
                { ...(options.env ?? process.env), ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}) },
                wsl,
            );
            for (const line of login.notes) say(line);
            signal?.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                const argv = config.ssoLoginCommand.map((s) => s.replaceAll("{profile}", profile));
                const child = start(argv[0] ?? "", argv.slice(1), { detached: true, stdio: "ignore", env: login.env });
                let stopped = false;
                let timedOut = false;
                const stop = () => {
                    if (stopped) return;
                    stopped = true;
                    if (child.pid) {
                        try {
                            process.kill(-child.pid, "SIGTERM");
                        } catch {}
                        const kill = setTimeout(() => {
                            try {
                                process.kill(-child.pid!, "SIGKILL");
                            } catch {}
                        }, 500);
                        kill.unref();
                    }
                };
                const timer = setTimeout(
                    () => {
                        timedOut = true;
                        stop();
                    },
                    Math.max(1, deadline - Date.now()),
                );
                signal?.addEventListener("abort", stop, { once: true });
                const finish = (ok: boolean) => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", stop);
                    ok && !stopped
                        ? resolve()
                        : reject(new SsoRecoveryError(signal?.aborted ? "cancelled" : timedOut ? "timeout" : "login"));
                };
                child.once("error", () => finish(false));
                child.once("close", (code) => finish(code === 0));
                if (signal?.aborted) stop();
            });
            succeeded = true;
        } finally {
            try {
                atomicCache(`${lock}.result`, { token, ok: succeeded });
            } finally {
                try {
                    unlinkSync(lock);
                } catch {}
            }
        }
    });
}
