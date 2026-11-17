export const JIG_BEDROCK = "jig-bedrock";
/** The one display name: Pi files it under API key, next to its own "Amazon Bedrock". */
export const BEDROCK_PROVIDER_NAME = "Amazon Bedrock (jig-bedrock)";
/** True for the plain provider and for every preset's `jig-bedrock-<preset>`. */
export const isOwnProvider = (providerId: string | undefined): boolean =>
    providerId === JIG_BEDROCK || (providerId !== undefined && presetOf(providerId) !== undefined);
/** True for a model of this package: the top level's or any preset's. */
export const isOwnModel = (model: { provider?: string } | undefined): boolean => isOwnProvider(model?.provider);

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
