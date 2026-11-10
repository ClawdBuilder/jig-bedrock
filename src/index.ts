// Pi entry point of the Bedrock provider. The factory only registers: no network, no processes, no timers and no file
// writes. Settings come from bedrock.json and the JIG_BEDROCK_* environment; AWS, the spend command and the browser are
// touched once a session starts, on a request, or by a command the user types.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BedrockOptions } from "./provider.ts";
import { createBedrockProvider } from "./provider.ts";

export type { BedrockOptions };

/** The extension. `options` replace the parts of the machine a test fakes: the catalog, the budget, the SSO recovery. */
export function jigBedrock(options: BedrockOptions = {}): ExtensionFactory {
    return (pi: ExtensionAPI) =>
        createBedrockProvider(options)(pi)
            .then(() => undefined)
            .catch(() => undefined);
}

export default jigBedrock();
