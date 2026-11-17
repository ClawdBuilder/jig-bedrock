export const JIG_BEDROCK = "jig-bedrock";
/** The one display name: Pi files it under API key, next to its own "Amazon Bedrock". */
export const BEDROCK_PROVIDER_NAME = "Amazon Bedrock (jig-bedrock)";
export const isOwnModel = (model: { provider?: string } | undefined) => model?.provider === JIG_BEDROCK;

/** The Pi provider id a preset's models live under; the top level keeps the plain id. */
export function providerIdOf(preset: string | undefined): string {
    return preset === undefined ? JIG_BEDROCK : `${JIG_BEDROCK}-${preset}`;
}

/** The display name Pi's /login lists for a preset's provider; the plain one keeps today's name. */
export function providerNameOf(preset: string | undefined): string {
    return preset === undefined ? BEDROCK_PROVIDER_NAME : `Amazon Bedrock (${providerIdOf(preset)})`;
}

/** The preset one of this package's provider ids names; undefined for the plain id or another provider's. */
export function presetOf(providerId: string): string | undefined {
    const prefix = `${JIG_BEDROCK}-`;
    return providerId.startsWith(prefix) && providerId.length > prefix.length
        ? providerId.slice(prefix.length)
        : undefined;
}
