// Pi entry point of the Bedrock provider. The factory only registers: no network, no processes, no timers and no file
// writes. jig-core may load before or after this extension: its `bedrock` section is applied when it appears and again at
// every session start. In plain Pi the provider reads ~/.pi/agent/bedrock.json and the JIG_BEDROCK_* environment. AWS,
// the usage program and the browser are touched once a session starts, on a request, or by a command the user types.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateBedrock } from "./config.ts";
import { jigApi, withJig } from "./jig/client.ts";
import type { BedrockHandle, BedrockOptions } from "./provider.ts";
import { createJigBedrock } from "./provider.ts";

export type { BedrockOptions };

/** The extension. `options` replace the parts of the machine a test fakes: the catalog, the budget, the SSO recovery. */
export function jigBedrock(options: BedrockOptions = {}): ExtensionFactory {
    return async (pi: ExtensionAPI) => {
        let handle: BedrockHandle | undefined;
        // Registered before the provider is built, so a jig-core that loads at any point (before, during or after the
        // factory) registers the section and asks the provider to re-read its settings.
        withJig((loaded) => {
            loaded.config.registerSection("bedrock", validateBedrock);
            handle?.applySettings(true);
        });
        const api = jigApi();
        handle = await createJigBedrock({ ...options, ...(api === undefined ? {} : { api }) })(pi).catch(
            () => undefined,
        );
        // jig-core may have appeared while the provider was being built; read its section now.
        if (handle !== undefined && jigApi() !== undefined) handle.applySettings(false);
    };
}

export default jigBedrock();
