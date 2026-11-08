// Pi entry point of the Bedrock provider. The factory only registers: no network, no processes, no timers and no file
// writes. jig-core must load before this extension for its `bedrock` section to apply (Jig's own order); in plain Pi the
// provider reads ~/.pi/agent/bedrock.json and the JIG_BEDROCK_* environment. AWS, the usage program and the browser are
// touched once a session starts, on a request, or by a command the user types.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateBedrock } from "./config.ts";
import { jigApi, withJig } from "./jig/client.ts";
import type { BedrockOptions } from "./provider.ts";
import { createJigBedrock } from "./provider.ts";

export type { BedrockOptions };

/** The extension. `options` replace the parts of the machine a test fakes: the catalog, the budget, the SSO recovery. */
export function jigBedrock(options: BedrockOptions = {}): ExtensionFactory {
    return async (pi: ExtensionAPI) => {
        // jig-core must already be loaded for its section to apply; a later load only registers the section, because
        // the provider has read its settings by then. Plain Pi uses bedrock.json and the JIG_BEDROCK_* environment.
        const api = jigApi();
        withJig((loaded) => {
            loaded.config.registerSection("bedrock", validateBedrock);
            if (api === undefined)
                pi.on("session_start", (_event, ctx) =>
                    ctx.ui.notify(
                        "jig-core loaded after the Bedrock provider, so its bedrock section is ignored this session; reload Pi to apply it.",
                        "warning",
                    ),
                );
        });
        await createJigBedrock({ ...options, ...(api === undefined ? {} : { api }) })(pi).catch(() => undefined);
    };
}

export default jigBedrock();
