// The two small checks the `bedrock` section shares. Errors name the key and never repeat a value.

export type Check = (raw: unknown, errors: string[]) => void;

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reports every key of `raw` that is not in `known`. */
export function knownKeys(raw: Record<string, unknown>, known: readonly string[], at: string, errors: string[]): void {
    for (const key of Object.keys(raw)) {
        if (!known.includes(key)) errors.push(`${at}.${key.slice(0, 40)} is not a known field`);
    }
}
