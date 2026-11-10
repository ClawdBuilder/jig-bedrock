// Pi entry point of the Bedrock provider. The factory only registers: no network, no processes, no timers and no file
// writes. Settings come from bedrock.json and the JIG_BEDROCK_* environment. Neither the factory nor Pi's own checks of the
// provider's credential start a program: AWS profile names are read from the AWS config and credentials files, never with
// the AWS CLI. A session start may begin, in the background and without being awaited, the model discovery (the AWS CLI,
// only when no fresh catalog is cached) and the spend command the user set; the browser opens only for a sign-in.
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
