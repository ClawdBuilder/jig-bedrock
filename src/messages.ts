// Per-model facts for Bedrock's Anthropic Messages route. Bedrock asks for the newer thinking shape on the Claude 5.5
// generation (adaptive, with output_config.effort) and refuses Pi's `thinking: {type: "disabled"}` on Sonnet 5.5, asking for
// `between_tools` instead; older Claude models still take budget thinking. Nothing here guesses beyond the generation the real
// run covered: a model only gets a rewrite when its family is listed below.
const ANTHROPIC = /^(?:[a-z0-9-]+\.)?anthropic\./;
const CLAUDE_55 = /^(?:[a-z0-9-]+\.)?anthropic\.claude-(?:sonnet|opus|haiku)-5-5$/;
// Sonnet 5.5 is the one model the real run proved needs between_tools when thinking is off; Opus and Haiku have not been
// tested with thinking off, so they stay as Pi sends them.
const BETWEEN_TOOLS = /^(?:[a-z0-9-]+\.)?anthropic\.claude-sonnet-5-5$/;
// Opus 5.5 cannot turn thinking off at all: the real run got the adaptive error on off. Pi reads a null level as "not
// available", so off leaves the picker and a saved off clamps to the lowest level Pi has.
const NO_OFF = /^(?:[a-z0-9-]+\.)?anthropic\.claude-opus-5-5$/;

/** A foundation model served by Bedrock's Anthropic Messages route. Anything else stays on its own route. */
export function isAnthropicModel(foundationModelId: string): boolean {
    return ANTHROPIC.test(foundationModelId);
}

/** The Claude generation that wants adaptive thinking; the older ones keep Pi's budget thinking. */
export function usesAdaptiveThinking(foundationModelId: string): boolean {
    return CLAUDE_55.test(foundationModelId);
}

/** Whether thinking-off is sent as `between_tools`. */
export function needsBetweenTools(foundationModelId: string): boolean {
    return BETWEEN_TOOLS.test(foundationModelId);
}

/** Whether the model has no thinking-off at all, which Pi expresses as a null entry in its thinking level map. */
export function noThinkingOff(foundationModelId: string): boolean {
    return NO_OFF.test(foundationModelId);
}

/**
 * Pi sends `thinking: {type: "disabled"}` when the level is off. Sonnet 5.5 answers with a 400 naming `between_tools`, so the
 * payload is rewritten for that model only; every other payload and model is returned as it came.
 */
export function rewriteThinkingOff(
    payload: Record<string, unknown>,
    foundationModelId: string,
): Record<string, unknown> {
    const thinking = payload.thinking as { type?: unknown } | undefined;
    if (thinking?.type !== "disabled" || !needsBetweenTools(foundationModelId)) return payload;
    return { ...payload, thinking: { type: "between_tools" } };
}
