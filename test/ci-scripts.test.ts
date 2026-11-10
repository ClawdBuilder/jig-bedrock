// The two scripts the CI jobs run, as far as they can be checked without a network: which environment Pi and npm get, and which
// Pi version is installed. The jobs themselves run them for real.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
// @ts-expect-error plain JavaScript script, no declaration file
import { resolveVersion } from "../scripts/install-pi.mjs";
// @ts-expect-error plain JavaScript script, no declaration file
import { cleanEnvironment } from "../scripts/packed-install-check.mjs";

test("Pi and npm run without the caller's AWS, Pi, Jig and npm settings, in a temporary home with a browser that does nothing", () => {
    const home = path.join("/", "tmp", "fixture-home");
    const agent = path.join(home, "agent");
    const env = cleanEnvironment(
        {
            PATH: "/usr/bin",
            AWS_PROFILE: "private",
            AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
            aws_region: "us-east-1",
            PI_OFFLINE: "1",
            PI_CODING_AGENT_DIR: "/real/agent",
            AI_AGENT: "pi",
            JIG_BEDROCK_PROFILE: "private",
            BROWSER: "firefox",
            HOME: "/real/home",
            npm_config_registry: "https://elsewhere.invalid/",
            npm_config_cache: "/real/cache",
            npm_package_name: "x",
            CI: "true",
        },
        home,
        agent,
        "http://127.0.0.1:1234/",
    );
    for (const name of Object.keys(env)) assert.doesNotMatch(name, /^(aws|jig)_/i, name);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.CI, "true");
    assert.equal(env.HOME, home);
    assert.equal(env.PI_CODING_AGENT_DIR, agent, "the agent folder is the temporary one, not the caller's");
    assert.equal(env.PI_OFFLINE, undefined);
    assert.equal(env.AI_AGENT, undefined);
    assert.equal(env.BROWSER, "true");
    assert.equal(env.npm_config_registry, "http://127.0.0.1:1234/");
    assert.equal(env.npm_config_cache, undefined);
    assert.equal(env.npm_package_name, undefined);
    assert.equal(env.NPM_CONFIG_USERCONFIG, path.join(home, ".npmrc"));
});

test("a named Pi version is installed as given; only `latest` asks the registry", () => {
    assert.equal(resolveVersion("1.5.0"), "1.5.0");
});
