export const JIG_BEDROCK = "jig-bedrock";
/** The one display name: Pi files it under API key, next to its own "Amazon Bedrock". */
export const BEDROCK_PROVIDER_NAME = "Amazon Bedrock (jig-bedrock)";
export const isOwnModel = (model: { provider?: string } | undefined) => model?.provider === JIG_BEDROCK;
