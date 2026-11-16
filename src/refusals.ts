// Models AWS refused for this AWS profile, remembered for seven days. The file holds no account id.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot, realCacheRoot } from "./cache-root.ts";

interface Refusal {
    id: string;
    until: number;
    date: string;
}
type Book = Record<string, Refusal>;

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
): void {
    if (profile === undefined || account === undefined) return;
    const book = read(env, profile, account);
    book[arn] = { id, until: now + 7 * 86_400_000, date: new Date(now).toISOString() };
    const path = file(env, profile, account);
    mkdirSync(join(realCacheRoot(env, true), "jig-bedrock"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(book)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
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
