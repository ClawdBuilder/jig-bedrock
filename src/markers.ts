// The doctor's four marks, with this package's fallbacks: symbols on a UTF-8 terminal, words when
// TERM=dumb or the locale cannot be assumed to be UTF-8 (CI logs, a C locale). NO_COLOR only removes colour.
export interface Markers {
    ok: string;
    warn: string;
    fail: string;
    skip: string;
}

const SYMBOLS: Markers = { ok: "✓", warn: "!", fail: "✗", skip: "–" };
const WORDS: Markers = { ok: "ok", warn: "warning", fail: "failure", skip: "skipped" };

/** A locale that can render the symbols: `en_US.UTF-8`, `C.utf8`; undefined or a bare C is not assumed. */
export function utf8Locale(locale: string | undefined): boolean {
    return locale !== undefined && /utf-?8/i.test(locale);
}

export function markers(env: NodeJS.ProcessEnv = process.env): Markers {
    const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
    return env.TERM === "dumb" || !utf8Locale(locale) ? WORDS : SYMBOLS;
}
