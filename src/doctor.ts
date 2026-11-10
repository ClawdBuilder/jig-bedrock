import { spawn } from "node:child_process";

type CheckStatus = "ready" | "old" | "missing" | "timeout" | "cancelled" | "overflow" | "unrecognized" | "unavailable";
export interface DependencyCheck {
    status: CheckStatus;
    version?: string;
}
export interface LocalDependencyHealth {
    node: DependencyCheck;
    aws: DependencyCheck;
    platform: NodeJS.Platform;
}
interface CheckOptions {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    platform?: NodeJS.Platform;
    timeout?: number;
    /** Test seams: a fake child and a timer that does not depend on the wall clock. */
    spawn?: typeof spawn;
    timer?: (fn: () => void, ms: number) => () => void;
}
type Tool = "aws";
const commands: Record<Tool, string[]> = {
    aws: ["--version"],
};
const patterns: Record<Tool, RegExp> = {
    aws: /\baws-cli\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?![\d.])/,
};
const atLeast = (version: string, minimum: number[]) => {
    const parts = version.split(".").map(Number);
    for (let i = 0; i < minimum.length; i++) {
        const wanted = minimum[i] ?? 0;
        if ((parts[i] ?? 0) !== wanted) return (parts[i] ?? 0) > wanted;
    }
    return true;
};
function versionCheck(version: string | undefined, minimum?: number[]): DependencyCheck {
    return version
        ? { status: !minimum || atLeast(version, minimum) ? "ready" : "old", version }
        : { status: "unrecognized" };
}
/** Fixed local version calls. Only numeric versions or closed failure categories leave this function. */
function probe(tool: Tool, minimum: number[] | undefined, options: CheckOptions): Promise<DependencyCheck> {
    return new Promise((resolve) => {
        if (options.signal?.aborted) {
            resolve({ status: "cancelled" });
            return;
        }
        const source = options.env ?? process.env;
        const env: NodeJS.ProcessEnv = {
            PATH: source.PATH ?? "",
            LANG: "C",
            LC_ALL: "C",
            AWS_CLI_AUTO_PROMPT: "off",
            AWS_PAGER: "",
            NO_COLOR: "1",
        };
        if (source.SystemRoot) env.SystemRoot = source.SystemRoot;
        let child: ReturnType<typeof spawn>,
            bytes = 0,
            settled = false;
        const output: Buffer[] = [];
        let cancelTimer: (() => void) | undefined;
        const stop = () => {
            if (options.spawn !== undefined) {
                try {
                    child?.kill("SIGKILL");
                } catch {}
                return;
            }
            if (!child?.pid) return;
            try {
                process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
            } catch {}
        };
        const finish = (result: DependencyCheck) => {
            if (settled) return;
            settled = true;
            cancelTimer?.();
            options.signal?.removeEventListener("abort", abort);
            if (result.status !== "ready" && result.status !== "old") stop();
            resolve(result);
        };
        const abort = () => finish({ status: "cancelled" });
        try {
            child = (options.spawn ?? spawn)(tool, commands[tool], {
                shell: false,
                env,
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
                windowsHide: true,
            });
        } catch {
            finish({ status: "unavailable" });
            return;
        }
        const collect = (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > 16_384) finish({ status: "overflow" });
            else output.push(chunk);
        };
        child.stdout!.on("data", collect);
        child.stderr!.on("data", collect);
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish({ status: error.code === "ENOENT" || error.code === "EACCES" ? "missing" : "unavailable" }),
        );
        child.on("close", (code) =>
            finish(
                code === 0
                    ? versionCheck(patterns[tool].exec(Buffer.concat(output).toString("utf8"))?.[1], minimum)
                    : { status: "unavailable" },
            ),
        );
        options.signal?.addEventListener("abort", abort, { once: true });
        const schedule =
            options.timer ??
            ((fn: () => void, ms: number) => {
                const handle = setTimeout(fn, ms);
                handle.unref();
                return () => clearTimeout(handle);
            });
        cancelTimer = schedule(() => finish({ status: "timeout" }), options.timeout ?? 3_000);
        if (options.signal?.aborted) abort();
    });
}
export async function checkLocalDependencies(options: CheckOptions = {}): Promise<LocalDependencyHealth> {
    const platform = options.platform ?? process.platform;
    const nodeVersion = /^(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(options.nodeVersion ?? process.versions.node)?.[1];
    const aws = await probe("aws", [2, 0, 0], options);
    return { node: versionCheck(nodeVersion, [22, 19, 0]), aws, platform };
}
const statusText: Record<CheckStatus, string> = {
    ready: "ready",
    old: "upgrade required",
    missing: "missing",
    timeout: "version check timed out",
    cancelled: "version check cancelled",
    overflow: "version output exceeded limit",
    unrecognized: "version not recognized",
    unavailable: "version check failed",
};
export function dependencyLines(health: LocalDependencyHealth): string[] {
    const line = (name: string, check: DependencyCheck, requirement: string) =>
        `${name}: ${check.version ?? "unknown"} · ${statusText[check.status]}${requirement ? ` (${requirement})` : ""}`;
    return [
        line("Node (this Pi process)", health.node, "requires 22.19+"),
        line("AWS CLI", health.aws, "requires v2"),
        "Only local --version output is checked; IAM access is not verified.",
    ];
}
