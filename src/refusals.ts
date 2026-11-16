// Models AWS refused for this AWS profile, remembered for seven days. The file holds no account id.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { cacheRoot, realCacheRoot } from "./cache-root.ts";

interface Refusal {
    id: string;
    until: number;
    date: string;
}
type Book = Record<string, Refusal>;

export interface RefusalSaveFailure {
    /** The cache folder, with the home directory shown as ~. */
    folder: string;
    /** The operating system's reason for the failed write. */
    reason: string;
    /** The whole line, ready to show after the refusal. */
    message: string;
}

const homeDisplay = (target: string, env: NodeJS.ProcessEnv): string => {
    const home = env.HOME;
    if (home === undefined || home === "") return target;
    const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
    return target === home || target.startsWith(prefix) ? `~${target.slice(home.length)}` : target;
};
const saveReason = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);
    const comma = raw.indexOf(",");
    return comma === -1 ? raw : raw.slice(0, comma);
};

function file(env: NodeJS.ProcessEnv, profile: string, account: string): string {
    const name = createHash("sha256").update(`${profile}\0${account}`).digest("hex").slice(0, 12);
    return join(realCacheRoot(env, true), "jig-bedrock", `refused-${name}.json`);
}
function read(env: NodeJS.ProcessEnv, profile: string, account: string): Book {
    try {
        const value = JSON.parse(readFileSync(file(env, profile, account), "utf8")) as unknown;
        return typeof value === "object" && value !== null ? (value as Book) : {};
    } catch {
        return {};
    }
}
export function isRefused(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    account: string | undefined,
    arn: string,
    now = Date.now(),
): boolean {
    if (profile === undefined || account === undefined) return false;
    const entry = read(env, profile, account)[arn];
    return entry !== undefined && entry.until > now;
}
export function rememberRefusal(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    account: string | undefined,
    arn: string,
    id: string,
    now = Date.now(),
): RefusalSaveFailure | undefined {
    if (profile === undefined || account === undefined) return undefined;
    const book = read(env, profile, account);
    book[arn] = { id, until: now + 7 * 86_400_000, date: new Date(now).toISOString() };
    const path = file(env, profile, account);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        mkdirSync(join(realCacheRoot(env, true), "jig-bedrock"), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, `${JSON.stringify(book)}\n`, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
    } catch (error) {
        try {
            rmSync(temporary, { force: true });
        } catch {}
        const folder = homeDisplay(dirname(path), env);
        const reason = saveReason(error);
        return {
            folder,
            reason,
            message: `Could not remember this refusal in ${folder}: ${reason}.`,
        };
    }
    return undefined;
}
export function refusedModels(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    account: string | undefined,
    now = Date.now(),
): Array<{ arn: string; id: string; date: string }> {
    if (profile === undefined || account === undefined) return [];
    return Object.entries(read(env, profile, account))
        .filter(([, entry]) => entry.until > now)
        .map(([arn, entry]) => ({ arn, id: entry.id, date: entry.date }));
}

/** The role refusal this package remembers; every other HTTP or transport failure keeps its normal path. */
export function isRefusalError(message: string, arn: string): boolean {
    return (
        /(?:\b403\b|AccessDenied)/i.test(message) &&
        /not authorized to perform:?\s*bedrock:InvokeModel(?:WithResponseStream)?/i.test(message) &&
        message.includes(arn) &&
        !/(?:^|\s)(?:400|429|5\d\d)(?:\s|$)|Throttl|Validation|expired|invalid.*token|network|timeout/i.test(message)
    );
}

/** Clear every remembered refusal for one AWS profile and account; returns how many were removed. */
export function clearRefusals(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    account: string | undefined,
): number {
    if (profile === undefined || account === undefined) return 0;
    const book = read(env, profile, account);
    const count = Object.keys(book).length;
    if (count === 0) return 0;
    try {
        writeFileSync(file(env, profile, account), "{}\n", { mode: 0o600 });
    } catch {
        return 0;
    }
    return count;
}
