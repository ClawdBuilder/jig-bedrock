// The AWS commercial region names this package knows, and the check for a region typed at /bedrock set, the settings
// menu or /login. The list is fixed: a new region should warn, not be refused, so a package release is not needed.
export const AWS_REGIONS = [
    "af-south-1",
    "ap-east-1",
    "ap-east-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-6",
    "ap-southeast-7",
    "ca-central-1",
    "ca-west-1",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "mx-central-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
] as const;

const KNOWN = new Set<string>(AWS_REGIONS);
const REGION_SHAPE = /^([a-z]{2}(?:-[a-z]+)+)-(\d+)$/;
const PREFIX_MAX = new Map<string, number>();
for (const region of AWS_REGIONS) {
    const match = REGION_SHAPE.exec(region);
    if (match === null) continue;
    const prefix = match[1] as string;
    const number = Number(match[2]);
    PREFIX_MAX.set(prefix, Math.max(PREFIX_MAX.get(prefix) ?? 0, number));
}

/** Levenshtein distance, only used to suggest a region after a typo. */
function distance(left: string, right: string): number {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        let previous = row[0] as number;
        row[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const saved = row[j] as number;
            row[j] = Math.min(
                (row[j] as number) + 1,
                (row[j - 1] as number) + 1,
                previous + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
            previous = saved;
        }
    }
    return row[right.length] as number;
}

/** Up to two known regions closest to a name, when the distance is small enough to be useful. */
export function regionSuggestions(region: string): string[] {
    return AWS_REGIONS.map((known) => ({ known, distance: distance(region.toLowerCase(), known) }))
        .filter((entry) => entry.distance <= 3)
        .sort((a, b) => a.distance - b.distance || (a.known < b.known ? -1 : a.known > b.known ? 1 : 0))
        .slice(0, 2)
        .map((entry) => entry.known);
}

export interface RegionCheck {
    /** A name that looks like a typo (or is malformed); the setting should be refused. */
    problem?: string;
    /** A name with the right shape but not on the list; accept it and say so. */
    warnings: string[];
}

/**
 * Check a region setting. A known commercial region is accepted. A name with the right shape but unknown is accepted
 * with a warning, unless its prefix is known and its number is past the next one (us-east-9), which is a typo.
 */
export function regionCheck(regions: readonly string[]): RegionCheck {
    const warnings: string[] = [];
    for (const region of regions) {
        if (KNOWN.has(region)) continue;
        const match = REGION_SHAPE.exec(region);
        const number = match === null ? undefined : Number(match[2]);
        const next = match === null ? undefined : PREFIX_MAX.get(match[1] as string);
        const malformed =
            match === null ||
            number === undefined ||
            number < 1 ||
            `${number}` !== match[2] ||
            (next !== undefined && number > next + 1);
        if (malformed) {
            const suggestions = regionSuggestions(region);
            const problem =
                suggestions.length === 0
                    ? `${region} is not an AWS region.`
                    : `${region} is not an AWS region; did you mean ${suggestions.join(" or ")}?`;
            return { problem, warnings };
        }
        warnings.push(`${region} is not in the known AWS region list; using it anyway so a new region is not blocked.`);
    }
    return { warnings };
}
