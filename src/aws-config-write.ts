// The one write jig-bedrock makes outside its own settings: add a profile to the AWS CLI's shared config. The file is
// hand-edited and shared with every AWS tool, so this appends only, keeps every existing byte (comments and unknown
// sections included), respects AWS_CONFIG_FILE, keeps the file's mode, writes through a temporary file, and leaves a
// timestamped backup (the five newest are kept). A config that is a symbolic link is written through, and the link stays.
// A lock file beside the config keeps two Pi processes from interleaving. It never opens ~/.aws/credentials and never sees
// a secret.
import {
    chmodSync,
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { awsConfigFile } from "./aws-profile.ts";

/** How many of this package's backups stay beside the config. */
const KEEP_BACKUPS = 5;
/** A lock older than this is a crashed writer's, and is taken over. */
const STALE_LOCK_MS = 30_000;

export interface ConfigSection {
    header: string;
    entries: Array<[string, string]>;
}

export interface ConfigWriteResult {
    file: string;
    written: boolean;
    backup?: string;
    error?: string;
}

/** The lines exactly as they will appear in the AWS config. */
export function renderSections(sections: ConfigSection[]): string {
    return sections
        .map((section) =>
            [`[${section.header}]`, ...section.entries.map(([key, value]) => `${key} = ${value}`)].join("\n"),
        )
        .join("\n\n");
}

function valid(sections: ConfigSection[]): boolean {
    if (sections.length === 0) return false;
    for (const section of sections) {
        if (section.header === "" || /[[\]\r\n]/.test(section.header)) return false;
        for (const [key, value] of section.entries) {
            if (!/^[A-Za-z0-9_]+$/.test(key) || /[\r\n]/.test(value)) return false;
        }
    }
    return true;
}

/** Section headers already in the file, including bare and `profile` forms, so a duplicate is refused. */
function headers(text: string): Set<string> {
    const found = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        if (match?.[1] !== undefined) found.add(match[1].trim());
    }
    return found;
}

function setMode(file: string, mode: number): void {
    try {
        chmodSync(file, mode);
    } catch {
        // Windows ignores POSIX modes; the file is already private where they matter.
    }
}

/** A temporary file in the same folder as `file`, then a rename, so a reader sees the old text or the new, never half. */
function atomic(file: string, text: string, mode: number): void {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, text, { mode });
        setMode(temporary, mode);
        renameSync(temporary, file);
    } catch (error) {
        try {
            unlinkSync(temporary);
        } catch {
            // Nothing was left behind, or it cannot be removed; the write error is the one to report.
        }
        throw error;
    }
}

/** The file a path really names: links followed, also a link whose target does not exist yet (the write creates it). */
function realTarget(file: string): string {
    try {
        return realpathSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let current = file;
    for (let hops = 0; hops < 40; hops++) {
        let link: string;
        try {
            if (!lstatSync(current).isSymbolicLink()) return current;
            link = readlinkSync(current);
        } catch {
            return current;
        }
        current = resolve(dirname(current), link);
    }
    return current;
}

/** `20261110T171500Z`: sorts as time does, and has no character a file system objects to. */
function stamp(date: Date): string {
    return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** The backups this package made of `file`, oldest first. A name that does not match exactly is not ours and is not listed. */
function backupsOf(file: string): string[] {
    const prefix = `${basename(file)}.jig-bedrock-backup-`;
    const found: Array<{ name: string; time: string; n: number }> = [];
    for (const name of readdirSync(dirname(file))) {
        if (!name.startsWith(prefix)) continue;
        const match = /^(\d{8}T\d{6}Z)(?:-(\d+))?$/.exec(name.slice(prefix.length));
        if (match?.[1] !== undefined) found.push({ name, time: match[1], n: Number(match[2] ?? 1) });
    }
    found.sort((a, b) => (a.time === b.time ? a.n - b.n : a.time < b.time ? -1 : 1));
    return found.map((entry) => resolve(dirname(file), entry.name));
}

/** A new backup next to `file`. Two writes in one second get `-2`, `-3`, ... so no backup is ever replaced. */
function makeBackup(file: string, text: string, mode: number, now: Date): string {
    for (let n = 1; ; n++) {
        const backup = `${file}.jig-bedrock-backup-${stamp(now)}${n === 1 ? "" : `-${n}`}`;
        try {
            writeFileSync(backup, text, { mode, flag: "wx" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
        setMode(backup, mode);
        return backup;
    }
}

/** Delete this package's backups of `file` beyond the newest few. A backup that cannot be deleted stays; it is not an error. */
function pruneBackups(file: string): void {
    for (const old of backupsOf(file).slice(0, -KEEP_BACKUPS)) {
        try {
            unlinkSync(old);
        } catch {
            // Already gone, or not ours to remove any more.
        }
    }
}

/** Take the lock beside `file`, or say it is held. A lock older than 30 seconds belongs to a writer that died and is taken over. */
function acquireLock(lock: string): "held" | "failed" | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lock, "wx", 0o600);
            try {
                writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
            } finally {
                closeSync(fd);
            }
            return undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "failed";
        }
        try {
            if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return "held";
            unlinkSync(lock);
        } catch (error) {
            // The holder finished between the two calls: try to take it again.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
        }
    }
    return "held";
}

/**
 * Append the sections to the AWS config; all checks happen before the backup or the write. `now` only names the backup.
 * The lock is held from the read to the end of the write, so two processes cannot both append to the same old text.
 */
export function writeAwsConfig(
    env: NodeJS.ProcessEnv,
    sections: ConfigSection[],
    now: () => Date = () => new Date(),
): ConfigWriteResult {
    const file = awsConfigFile(env);
    if (!valid(sections)) {
        return { file, written: false, error: "The lines for the AWS config are not valid." };
    }
    const failed = (): ConfigWriteResult => ({
        file,
        written: false,
        error: `${file} could not be written; check its permissions and free space.`,
    });
    // A link is written through: the real file gets the new text, and the link stays where it is.
    let target = file;
    try {
        target = realTarget(file);
    } catch {
        // A folder on the way cannot be read: the read below says so in the right words.
    }
    const lock = `${target}.jig-bedrock.lock`;
    try {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    } catch {
        return failed();
    }
    const taken = acquireLock(lock);
    if (taken === "held") return { file, written: false, error: `Another program is changing ${file}; try again.` };
    if (taken === "failed") return failed();
    try {
        let original = "";
        let mode: number | undefined;
        try {
            original = readFileSync(target, "utf8");
            mode = statSync(target).mode & 0o777;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return { file, written: false, error: `${file} could not be read; check its permissions.` };
            }
            mode = 0o600;
        }
        const existing = headers(original);
        for (const section of sections) {
            if (existing.has(section.header)) {
                return {
                    file,
                    written: false,
                    error: `[${section.header}] already exists in ${file}; choose another name.`,
                };
            }
        }
        let body = original;
        if (body !== "") {
            if (!body.endsWith("\n")) body += "\n";
            if (!body.endsWith("\n\n")) body += "\n";
        }
        const next = `${body}${renderSections(sections)}\n`;
        let backup: string | undefined;
        try {
            if (original !== "") backup = makeBackup(target, original, mode, now());
            atomic(target, next, mode);
        } catch {
            return failed();
        }
        pruneBackups(target);
        return { file, written: true, ...(backup === undefined ? {} : { backup }) };
    } finally {
        try {
            unlinkSync(lock);
        } catch {
            // Already gone; nothing else can be done about a lock that will not delete.
        }
    }
}
