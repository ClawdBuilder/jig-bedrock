// Reading the AWS CLI's shared files, with no AWS CLI: where they are, their sections, and the profile names in them.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The AWS CLI's shared config file: `AWS_CONFIG_FILE`, else `~/.aws/config`. */
export function awsConfigFile(env: NodeJS.ProcessEnv = process.env): string {
    return env.AWS_CONFIG_FILE !== undefined && env.AWS_CONFIG_FILE !== ""
        ? env.AWS_CONFIG_FILE
        : join(env.HOME ?? homedir(), ".aws", "config");
}

/** The AWS CLI's shared credentials file: `AWS_SHARED_CREDENTIALS_FILE`, else `~/.aws/credentials`. */
export function awsCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
    return env.AWS_SHARED_CREDENTIALS_FILE !== undefined && env.AWS_SHARED_CREDENTIALS_FILE !== ""
        ? env.AWS_SHARED_CREDENTIALS_FILE
        : join(env.HOME ?? homedir(), ".aws", "credentials");
}

/** The sections of an AWS config file, keyed `profile:<name>`, `sso-session:<name>` or the bare name. */
export function parseAwsConfig(text: string): Map<string, Map<string, string>> {
    const sections = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
        if (line.startsWith("[") && line.endsWith("]")) {
            const name = line.slice(1, -1).trim();
            const key = name.startsWith("profile ")
                ? `profile:${name.slice("profile ".length).trim()}`
                : name.startsWith("sso-session ")
                  ? `sso-session:${name.slice("sso-session ".length).trim()}`
                  : name;
            current = new Map();
            sections.set(key, current);
            continue;
        }
        const equals = line.indexOf("=");
        if (equals <= 0 || current === undefined) continue;
        current.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
    }
    return sections;
}

/** The text of a file, or undefined when it is missing or cannot be read. */
function readText(file: string): string | undefined {
    try {
        return readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

/**
 * The profile names `aws configure list-profiles` prints, read from the files: `[default]` and `[profile NAME]` in the
 * config file, then `[NAME]` in the credentials file, each name once, in file order. A missing file lists nothing. Only
 * names leave this function, never a value.
 */
export function listProfileNames(
    env: NodeJS.ProcessEnv = process.env,
    read: (file: string) => string | undefined = readText,
): string[] {
    const names = new Set<string>();
    const config = read(awsConfigFile(env));
    if (config !== undefined)
        for (const key of parseAwsConfig(config).keys()) {
            if (key.startsWith("profile:")) names.add(key.slice("profile:".length));
            else if (key === "default") names.add(key);
        }
    const credentials = read(awsCredentialsFile(env));
    if (credentials !== undefined)
        for (const key of parseAwsConfig(credentials).keys())
            if (!key.startsWith("profile:") && !key.startsWith("sso-session:")) names.add(key);
    return [...names].filter((name) => name !== "");
}
