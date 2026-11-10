// The one file jig-bedrock writes: the user's own bedrock.json. The /login flow saves discovery choices there (never the
// profile, which belongs to the credential), and leaves every other key alone. No secret ever reaches this file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DiscoverySettings {
    mode: "system" | "tag" | "explicit";
    regions: string[];
    tagKey?: string;
    tagValue?: string;
    profiles?: string[];
}

export interface SaveDiscoveryResult {
    file: string;
    written: boolean;
    shadowed: string[];
    error?: string;
}

/** Keys that encode the discovery mode; replaced together, so one choice never leaves another's keys behind. */
const modeKeys = ["team", "tagKey", "tagValue", "activeTagKey", "activeTagValue", "profiles"] as const;

function bedrockFile(env: NodeJS.ProcessEnv): string {
    const folder =
        env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR !== ""
            ? env.PI_CODING_AGENT_DIR
            : join(env.HOME ?? homedir(), ".pi", "agent");
    return join(folder, "bedrock.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge the discovery choice into bedrock.json. */
export function saveDiscoverySettings(env: NodeJS.ProcessEnv, settings: DiscoverySettings): SaveDiscoveryResult {
    const file = bedrockFile(env);
    let document: Record<string, unknown> = {};
    try {
        const text = readFileSync(file, "utf8");
        const parsed = JSON.parse(text) as unknown;
        if (!isObject(parsed)) {
            return { file, written: false, shadowed: [], error: `${file} does not hold a JSON object.` };
        }
        document = parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return {
                file,
                written: false,
                shadowed: [],
                error: `${file} could not be read as JSON; fix it, then run /login again.`,
            };
        }
    }
    const target = isObject(document.bedrock) ? document.bedrock : document;
    for (const key of modeKeys) delete target[key];
    if (settings.mode === "tag") {
        target.tagKey = settings.tagKey;
        target.tagValue = settings.tagValue;
    } else if (settings.mode === "explicit") {
        target.profiles = settings.profiles;
    }
    target.regions = settings.regions;
    const keys = new Set<string>([...modeKeys, "regions"]);
    const shadowed: string[] = [];
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
    } catch {
        return {
            file,
            written: false,
            shadowed,
            error: `${file} could not be written; check the permissions on its folder.`,
        };
    }
    return { file, written: true, shadowed };
}

/** Set or clear monthlyBudgetUsd in bedrock.json, leaving every other key alone. */
export function saveBudgetSetting(
    env: NodeJS.ProcessEnv,
    value: number | undefined,
): { ok: boolean; file: string; error?: string } {
    const file = bedrockFile(env);
    let document: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!isObject(parsed)) return { ok: false, file, error: `${file} does not hold a JSON object.` };
        document = parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return { ok: false, file, error: `${file} could not be read as JSON; fix it, then try again.` };
    }
    const target = isObject(document.bedrock) ? document.bedrock : document;
    if (value === undefined) delete target.monthlyBudgetUsd;
    else target.monthlyBudgetUsd = value;
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
        return { ok: true, file };
    } catch {
        return { ok: false, file, error: `${file} could not be written; check its folder permissions.` };
    }
}

export interface SettingsDocument {
    file: string;
    document: Record<string, unknown>;
    target: Record<string, unknown>;
}
export function readSettingsDocument(env: NodeJS.ProcessEnv): SettingsDocument | { file: string; error: string } {
    const file = bedrockFile(env);
    let document: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!isObject(parsed)) return { file, error: `${file} does not hold a JSON object.` };
        document = parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return { file, error: `${file} is not valid JSON; fix it, then try again.` };
    }
    return { file, document, target: isObject(document.bedrock) ? document.bedrock : document };
}
export function writeSettingsDocument(
    env: NodeJS.ProcessEnv,
    document: Record<string, unknown>,
): { ok: boolean; file: string; error?: string } {
    const file = bedrockFile(env);
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
        return { ok: true, file };
    } catch {
        return { ok: false, file, error: `${file} could not be written; check its folder permissions.` };
    }
}
