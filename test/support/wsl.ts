// WSL, as a test sees it: either not there at all, or there with exactly what the test says. Nothing here asks the machine, so a
// test gives the same answer on WSL, on Linux and on a Mac, and none starts a Windows program.
import assert from "node:assert/strict";
import type { WslDeps } from "../../src/wsl.ts";

/** A machine that is not WSL. Asking whether Windows answers is a mistake. */
export const elsewhere: WslDeps = {
    isWsl: () => false,
    executable: () => false,
    exists: () => false,
    interopAnswers: async () => assert.fail("a machine that is not WSL does not probe the interop socket"),
    browserScript: "/unused/windows-browser",
};

/** WSL with the Windows side and the distro's own socket present and the probe answering `answers`; `over` changes any of it. */
export function underWsl(answers: boolean, over: Partial<WslDeps> = {}): WslDeps & { probes: NodeJS.ProcessEnv[] } {
    const probes: NodeJS.ProcessEnv[] = [];
    return {
        isWsl: () => true,
        executable: () => true,
        exists: () => true,
        interopAnswers: async (env) => {
            probes.push(env);
            return answers;
        },
        browserScript: "/package/bin/windows-browser",
        ...over,
        probes,
    };
}
