export const JIG_BEDROCK = "jig-bedrock";
export const isJigBedrock = (model: { provider?: string } | undefined) =>
    model?.provider === JIG_BEDROCK || model?.provider === "amazon-bedrock";
