// The one write jig-bedrock makes outside its own settings: add a profile to the AWS CLI's shared config. The file is
// hand-edited and shared with every AWS tool, so this appends only, keeps every existing byte (comments and unknown
// sections included), respects AWS_CONFIG_FILE, keeps the file's mode, writes through a temporary file, and leaves a
// backup. It never opens ~/.aws/credentials and never sees a secret.
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { awsConfigFile } from "./aws-profile.ts";

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

function atomic(file: string, text: string, mode: number): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode });
    try {
        chmodSync(temporary, mode);
    } catch {
        // Windows ignores POSIX modes; the temporary file is already private where they matter.
    }
    renameSync(temporary, file);
}

/** Append the sections to the AWS config; all checks happen before the backup or the write. */
export function writeAwsConfig(env: NodeJS.ProcessEnv, sections: ConfigSection[]): ConfigWriteResult {
    const file = awsConfigFile(env);
    if (!valid(sections)) {
        return { file, written: false, error: "The lines for the AWS config are not valid." };
    }
    let original = "";
    let mode: number | undefined;
    try {
        original = readFileSync(file, "utf8");
        mode = statSync(file).mode & 0o777;
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
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        let backup: string | undefined;
        if (original !== "") {
            backup = `${file}.jig-bedrock.bak`;
            atomic(backup, original, mode);
        }
        atomic(file, next, mode);
        return { file, written: true, ...(backup === undefined ? {} : { backup }) };
    } catch {
        return {
            file,
            written: false,
            error: `${file} could not be written; check its permissions and free space.`,
        };
    }
}
