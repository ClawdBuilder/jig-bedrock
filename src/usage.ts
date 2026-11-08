import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ResolvedConfig } from "./config.ts";

export type UsageFailure =
    | "missing"
    | "timeout"
    | "cancelled"
    | "sso_expired"
    | "permission"
    | "network"
    | "invalid_result"
    | "unavailable";
export class UsageError extends Error {
    readonly kind: UsageFailure;
    constructor(kind: UsageFailure) {
        super(usageHelp(kind));
        this.kind = kind;
        this.name = "UsageError";
    }
}
export function usageHelp(kind: UsageFailure): string {
    switch (kind) {
        case "missing":
            return "usage program statistics unavailable. No usage program: put an executable named usage in usageDir that prints the documented JSON.";
        case "timeout":
            return "usage program statistics timed out. Check AWS network access and retry the command.";
        case "cancelled":
            return "usage program statistics cancelled.";
        case "sso_expired":
            return "usage program statistics need AWS sign-in. Run /aws-login, complete browser sign-in, then retry the statistics command.";
        case "permission":
            return "usage program statistics access denied. Ask your AWS administrator to check the configured profile's read permissions.";
        case "network":
            return "usage program statistics could not reach AWS. Check network access and retry the command.";
        case "invalid_result":
            return "usage program returned an unsupported or invalid statistics report. Update usage program and the Bedrock extension together.";
        default:
            return "usage program statistics unavailable. Run /bedrock-doctor and check usage program setup.";
    }
}
export interface UsageRunOptions {
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
}
export type UsageRunner = (program: string, args: string[], options: UsageRunOptions) => Promise<string>;
function classify(stderr: string): UsageFailure {
    return /sso|token/i.test(stderr) && /expired|invalid|login|unauthorized|does not exist/i.test(stderr)
        ? "sso_expired"
        : /access.?denied|not authorized|unauthorizedoperation/i.test(stderr)
          ? "permission"
          : /network|connect|dns|resolve|unreachable|proxy/i.test(stderr)
            ? "network"
            : "unavailable";
}
/** Run only the configured executable; child output never becomes an exception or transcript. */
export const runUsage: UsageRunner = (program, args, options) =>
    new Promise((accept, reject) => {
        if (options.signal?.aborted) {
            reject(new UsageError("cancelled"));
            return;
        }
        let child: ReturnType<typeof spawn>,
            output = "",
            stderr = "",
            bytes = 0,
            settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            if (!child?.pid) return;
            try {
                process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
            } catch {}
        };
        const finish = (error?: UsageError) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            if (error) {
                stop();
                reject(error);
            } else accept(output);
        };
        const abort = () => finish(new UsageError("cancelled"));
        try {
            child = spawn(program, args, {
                env: options.env ?? process.env,
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
                windowsHide: true,
            });
        } catch {
            finish(new UsageError("missing"));
            return;
        }
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > options.maxBuffer) finish(new UsageError("invalid_result"));
            else output += chunk;
        });
        child.stderr!.on("data", (chunk: string) => {
            if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
        });
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish(new UsageError(error.code === "ENOENT" || error.code === "EACCES" ? "missing" : "unavailable")),
        );
        child.on("close", (code) => finish(code === 0 ? undefined : new UsageError(classify(stderr))));
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(new UsageError("timeout")), options.timeout);
        timer.unref();
        if (options.signal?.aborted) abort();
    });
export const usageExecutable = (config: ResolvedConfig): string =>
    join(
        config.usageDir.startsWith("~/") ? join(homedir(), config.usageDir.slice(2)) : resolve(config.usageDir),
        "usage",
    );
export function executableExists(file: string): boolean {
    try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
    } catch {
        return false;
    }
}
export function executableOnPath(program: string, env = process.env): boolean {
    return (env.PATH || "")
        .split(delimiter)
        .filter(Boolean)
        .some((dir) => executableExists(join(dir, program)));
}
