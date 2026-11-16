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

function file(env: NodeJS.ProcessEnv, profile: string): string {
    const name = createHash("sha256").update(profile).digest("hex").slice(0, 12);
    return join(realCacheRoot(env, true), "jig-bedrock", `refused-${name}.json`);
}
function read(env: NodeJS.ProcessEnv, profile: string): Book {
    try {
        const value = JSON.parse(readFileSync(file(env, profile), "utf8")) as unknown;
        return typeof value === "object" && value !== null ? (value as Book) : {};
    } catch {
        return {};
    }
}
export function isRefused(env: NodeJS.ProcessEnv, profile: string | undefined, arn: string, now = Date.now()): boolean {
    if (profile === undefined) return false;
    const entry = read(env, profile)[arn];
    return entry !== undefined && entry.until > now;
}
export function rememberRefusal(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    arn: string,
    id: string,
    now = Date.now(),
): void {
    if (profile === undefined) return;
    const book = read(env, profile);
    book[arn] = { id, until: now + 7 * 86_400_000, date: new Date(now).toISOString() };
    const path = file(env, profile);
    mkdirSync(join(realCacheRoot(env, true), "jig-bedrock"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(book)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
}
export function refusedModels(
    env: NodeJS.ProcessEnv,
    profile: string | undefined,
    now = Date.now(),
): Array<{ arn: string; id: string; date: string }> {
    if (profile === undefined) return [];
    return Object.entries(read(env, profile))
        .filter(([, entry]) => entry.until > now)
        .map(([arn, entry]) => ({ arn, id: entry.id, date: entry.date }));
}
