// What the AWS sign-in needs from WSL, where Pi often runs. Two things go wrong there, and both are repaired for the sign-in's
// child process only, never for Pi itself:
//
//   The browser.  `aws sso login` opens $BROWSER. Inside WSL there is usually none, so the sign-in prints a link nobody sees.
//                 With no BROWSER set (by the user, or by bedrock.browser) the child gets bin/windows-browser, which hands the
//                 address to the Windows default browser. bedrock.browser names another program and wins everywhere.
//   The interop.  WSL_INTEROP names the socket through which Linux starts Windows programs. A long-lived terminal or tmux server
//                 can hold the socket of a session that is gone, and then every Windows program, the browser among them, hangs
//                 and fails. A live socket answers `cmd.exe /c exit` in well under a second. When it does not, the child gets
//                 the distro's own socket, which lives as long as WSL does. This follows the same rule.
//
// Outside WSL nothing here changes anything, except that bedrock.browser, which the user wrote, is still used.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The program that probes the interop socket: any Windows program would do, this one is always there. */
export const WINDOWS_CMD = "/mnt/c/Windows/System32/cmd.exe";
/** The distro's own interop socket. */
export const INTEROP_FALLBACK = "/run/WSL/1_interop";
/** How long the probe may take: a live socket answers in well under a second. */
export const PROBE_TIMEOUT_MS = 2_000;
/** The script that opens an address in the Windows default browser. */
export const BROWSER_SCRIPT = fileURLToPath(new URL("../bin/windows-browser", import.meta.url));

/** The parts of the machine this reads and runs, which a test replaces. */
export interface WslDeps {
    isWsl(env: NodeJS.ProcessEnv): boolean;
    executable(file: string): boolean;
    exists(file: string): boolean;
    /** Whether Windows answers through the socket `env.WSL_INTEROP` names: runs `cmd.exe /c exit` for at most 2 seconds. */
    interopAnswers(env: NodeJS.ProcessEnv): Promise<boolean>;
    browserScript: string;
}

export const systemWsl: WslDeps = {
    isWsl(env) {
        if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
        try {
            return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
        } catch {
            return false;
        }
    },
    executable(file) {
        try {
            accessSync(file, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    },
    exists: existsSync,
    interopAnswers: (env) =>
        new Promise((resolve) => {
            const child = spawn(WINDOWS_CMD, ["/c", "exit"], { stdio: "ignore", env });
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve(false);
            }, PROBE_TIMEOUT_MS);
            child.once("error", () => {
                clearTimeout(timer);
                resolve(false);
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                resolve(code === 0);
            });
        }),
    browserScript: BROWSER_SCRIPT,
};

export interface LoginEnvironment {
    /** The environment for the sign-in's child: `base` with the repairs. `base` itself is not changed. */
    env: NodeJS.ProcessEnv;
    /** One line for the user for each repair that was made. */
    notes: string[];
}

/** The environment `aws sso login` starts with: `base`, the browser and the interop socket as described above. */
export async function loginEnvironment(
    settings: { browser?: string },
    base: NodeJS.ProcessEnv,
    deps: WslDeps = systemWsl,
): Promise<LoginEnvironment> {
    const env = { ...base };
    const notes: string[] = [];
    // A program the user named wins everywhere: they wrote it in jig.json.
    if (settings.browser) env.BROWSER = settings.browser;
    if (!deps.isWsl(base)) return { env, notes };
    const socket = base.WSL_INTEROP;
    if (
        socket &&
        socket !== INTEROP_FALLBACK &&
        deps.executable(WINDOWS_CMD) &&
        deps.exists(INTEROP_FALLBACK) &&
        !(await deps.interopAnswers(base))
    ) {
        env.WSL_INTEROP = INTEROP_FALLBACK;
        notes.push(
            `The Windows interop socket ${socket} does not answer; using ${INTEROP_FALLBACK} for the AWS sign-in.`,
        );
    }
    // A BROWSER the user set is theirs. An unset one, or an empty one, which programs ignore, is filled.
    if (!settings.browser && !base.BROWSER) env.BROWSER = deps.browserScript;
    return { env, notes };
}
