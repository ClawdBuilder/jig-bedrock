// What the provider tells other plugins on Pi's event bus, in the shapes optional Jig display plugins read. Neither is imported:
// an event nobody listens to does nothing.
//
//   jig-theme:segment      { id, label, tone? }                    an optional footer part
//   jig-lens:model-names   { models: [{ recorded, name, provider }] }   names for recorded models
import type { Budget } from "./budget.ts";
import type { TeamBedrockModel } from "./catalog.ts";
import { JIG_BEDROCK } from "./identity.ts";

export const SEGMENT_EVENT = "jig-theme:segment";
export const MODEL_NAMES_EVENT = "jig-lens:model-names";
export const SEGMENT_ID = "bedrock-spend";
/** The share of the budget from which the part turns to a warning. */
export const AMBER_FROM = 0.8;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (value: number): string => `$${value >= 10 ? String(Math.round(value)) : value.toFixed(2)}`;

export interface Segment {
    id: string;
    label: string;
    tone?: "normal" | "warning" | "error";
}

/**
 * `Oct $203 / $200`; a trailing + on the spend means some usage had no price, so it is a lower bound. A warning from 80% of the
 * budget, an error at or above it. A figure from another month is not shown (the month rolls over in UTC, as the extension
 * counts it), and a part with nothing to say has an empty label, which removes it.
 */
export function spendSegment(budget: Budget | undefined, now: number): Segment {
    if (budget === undefined || new Date(now).toISOString().slice(0, 7) !== budget.monthUtc) {
        return { id: SEGMENT_ID, label: "" };
    }
    const month = MONTHS[Number(budget.monthUtc.slice(5)) - 1] ?? budget.monthUtc;
    const limit = budget.limitUsd !== undefined && budget.limitUsd > 0 ? budget.limitUsd : undefined;
    const label = `${month} ${money(budget.spentUsd)}${budget.unpriced ? "+" : ""}${limit === undefined ? "" : ` / ${money(limit)}`}`;
    const used = limit === undefined ? 0 : budget.spentUsd / limit;
    return { id: SEGMENT_ID, label, tone: used >= 1 ? "error" : used >= AMBER_FROM ? "warning" : "normal" };
}

/** Pi records a reply under the inference profile's ARN, which says nothing to a reader: this names it by the model's id. */
export function modelNames(models: readonly TeamBedrockModel[]): {
    models: Array<{ recorded: string; name: string; provider: string }>;
} {
    return { models: models.map((model) => ({ recorded: model.arn, name: model.id, provider: JIG_BEDROCK })) };
}
