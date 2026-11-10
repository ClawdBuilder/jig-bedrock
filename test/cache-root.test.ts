// The user's own cache root may be a link (`~/.cache` on another disk, a temporary folder under /var on macOS): it is followed,
// because it is their choice. From this package's own folder (`jig-bedrock`) down a link is still refused, and so is a link in
// the place of the cache file.
import assert from "node:assert/strict";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery, type Runner } from "../src/aws-discovery.ts";
import { atomicCache } from "../src/cache.ts";
import { cacheRoot, catalogFile, realCacheRoot } from "../src/cache-root.ts";
import { ssoRuntime } from "../src/login.ts";

const config = { regions: ["us-east-1"], ssoLoginCommand: ["fixture", "{profile}"], signInAtStart: false };

/** A runner for the system-defined listing with no profiles: enough for a successful discovery and a cache file. */
const runner: Runner = async (_program, args) =>
    JSON.stringify(
        args.includes("get-caller-identity") ? { Account: "123456789012" } : { inferenceProfileSummaries: [] },
    );

function folder(t: test.TestContext): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jig-bedrock-cache-root-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("the cache root is XDG_CACHE_HOME when it is absolute, else ~/.cache", () => {
    assert.equal(cacheRoot({ XDG_CACHE_HOME: "/data/cache", HOME: "/home/a" }), "/data/cache");
    assert.equal(cacheRoot({ XDG_CACHE_HOME: "relative", HOME: "/home/a" }), "/home/a/.cache");
    assert.equal(cacheRoot({ XDG_CACHE_HOME: "", HOME: "/home/a" }), "/home/a/.cache");
    assert.equal(cacheRoot({ HOME: "/home/a" }), "/home/a/.cache");
});

test("a linked cache root works: the cache is written, then read", async (t) => {
    const dir = folder(t);
    const real = join(dir, "other-disk", "cache");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(dir, "cache-link"));
    const env = { XDG_CACHE_HOME: join(dir, "cache-link") };
    assert.equal(realCacheRoot(env), real);
    // The guard itself has not loosened: handed the linked path it refuses, which is why the root is resolved first.
    assert.throws(
        () => atomicCache(join(env.XDG_CACHE_HOME, "jig-bedrock", "catalog.json"), {}),
        /Unsafe cache directory/,
    );
    const first = createAwsDiscovery(config, runner, undefined, undefined, env);
    assert.equal(await first.refresh(true), "ok");
    assert.ok(existsSync(join(real, "jig-bedrock", "catalog.json")), "the file is in the real folder");
    assert.equal(statSync(join(real, "jig-bedrock", "catalog.json")).mode & 0o777, 0o600);
    assert.equal(first.load()?.account_id, "123456789012");
    // A new process: nothing but the file, and a fresh cache means no AWS call.
    let calls = 0;
    const second = createAwsDiscovery(
        config,
        async (...args) => {
            calls++;
            return runner(...args);
        },
        undefined,
        undefined,
        env,
    );
    assert.equal(second.load()?.account_id, "123456789012");
    assert.equal(await second.refresh(false), "ok");
    assert.equal(calls, 0);
});

test("a ~/.cache that is a link works too, and a missing cache root is made first", async (t) => {
    const dir = folder(t);
    mkdirSync(join(dir, "elsewhere"));
    mkdirSync(join(dir, "home"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "home", ".cache"));
    const linked = { HOME: join(dir, "home") };
    const source = createAwsDiscovery(config, runner, undefined, undefined, linked);
    assert.equal(await source.refresh(true), "ok");
    assert.ok(existsSync(join(dir, "elsewhere", "jig-bedrock", "catalog.json")));
    assert.ok(source.load());

    const missing = { XDG_CACHE_HOME: join(dir, "not", "yet", "there") };
    assert.equal(createAwsDiscovery(config, runner, undefined, undefined, missing).load(), undefined);
    assert.equal(existsSync(missing.XDG_CACHE_HOME), false, "reading does not make the root");
    const made = createAwsDiscovery(config, runner, undefined, undefined, missing);
    assert.equal(await made.refresh(true), "ok");
    assert.equal(statSync(join(missing.XDG_CACHE_HOME, "jig-bedrock")).mode & 0o777, 0o700);
    assert.ok(made.load());
});

test("a link at jig-bedrock is refused: nothing is written through it and nothing is read through it", async (t) => {
    const dir = folder(t);
    const root = join(dir, "cache");
    const target = join(dir, "target");
    const env = { XDG_CACHE_HOME: root };
    // A good cache, made where it is allowed, then moved behind a link at `jig-bedrock`.
    assert.equal(await createAwsDiscovery(config, runner, undefined, undefined, env).refresh(true), "ok");
    renameSync(join(root, "jig-bedrock"), target);
    symlinkSync(target, join(root, "jig-bedrock"));
    const before = readdirSync(target);
    const source = createAwsDiscovery(config, runner, undefined, undefined, env);
    assert.equal(source.load(), undefined, "a good cache behind the link is not read");
    assert.notEqual(await source.refresh(true), "ok");
    assert.deepEqual(readdirSync(target), before, "nothing was written through the link");
    assert.equal(lstatSync(join(root, "jig-bedrock")).isSymbolicLink(), true);
    assert.throws(() => atomicCache(join(root, "jig-bedrock", "catalog.json"), {}), /Unsafe cache directory/);
});

test("a link in the place of the cache file is refused when read", async (t) => {
    const dir = folder(t);
    const env = { XDG_CACHE_HOME: join(dir, "cache") };
    assert.equal(await createAwsDiscovery(config, runner, undefined, undefined, env).refresh(true), "ok");
    const file = catalogFile(env);
    const copy = join(dir, "copy.json");
    writeFileSync(copy, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(copy, file);
    assert.equal(createAwsDiscovery(config, runner, undefined, undefined, env).load(), undefined);
});

test("the SSO runtime folder follows a link at .local or state, and refuses one at jig-bedrock", (t) => {
    const dir = folder(t);
    const home = join(dir, "home");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(dir, "disk", "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".local"), { mode: 0o700 });
    symlinkSync(join(dir, "disk", "state"), join(home, ".local", "state"));
    const runtime = ssoRuntime({ HOME: home });
    assert.ok(existsSync(join(dir, "disk", "state", "jig-bedrock", "sso-runtime")));
    assert.equal(statSync(runtime).mode & 0o777, 0o700);
    // A link at the package's own folder is not followed.
    const other = join(dir, "other-home");
    mkdirSync(join(other, ".local", "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(dir, "elsewhere"), join(other, ".local", "state", "jig-bedrock"));
    assert.throws(() => ssoRuntime({ HOME: other }), /runtime/);
    // And a home folder that is itself a link is the user's own choice.
    symlinkSync(home, join(dir, "home-link"));
    assert.equal(
        ssoRuntime({ HOME: join(dir, "home-link") }),
        join(dir, "home-link", ".local", "state", "jig-bedrock", "sso-runtime"),
    );
});
