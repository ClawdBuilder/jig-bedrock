import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { registerStatisticsCommands } from "../src/commands.ts";
import { checkLocalDependencies, dependencyLines } from "../src/doctor.ts";

type Hook = (...args: any[]) => any;

const config = {
    team: "Fixture",
    profile: "fixture",
    regions: ["us-east-1"],
    usageDir: "/missing",
    ssoLoginCommand: ["fixture"],
    signInAtStart: false,
};
function directory(t: any) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-doctor-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function executable(dir: string, name: string, body: string) {
    writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
}
function fixtures(t: any, versions = { aws: "2.22.1", bash: "5.2.21", jq: "1.8.1" }) {
    const dir = directory(t);
    executable(
        dir,
        "aws",
        `process.stderr.write(${JSON.stringify(`aws-cli/${versions.aws} Python/3.11 private-canary`)});`,
    );
    executable(
        dir,
        "bash",
        `process.stdout.write(${JSON.stringify(`GNU bash, version ${versions.bash}(1)-release`)});`,
    );
    executable(dir, "jq", `process.stdout.write(${JSON.stringify(`jq-${versions.jq}`)});`);
    executable(
        dir,
        "usage",
        `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "usage-was-executed"))}, "bad"); process.exit(91);`,
    );
    return dir;
}

test("local doctor parses only numeric versions with fixed argv, an isolated environment and no usage program invocation", async (t) => {
    const dir = fixtures(t),
        marker = join(dir, "argv.json");
    executable(
        dir,
        "aws",
        `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2), env:process.env})); process.stderr.write("aws-cli/2.22.1 private-canary");`,
    );
    executable(
        dir,
        "bash",
        `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(join(dir, "bash-argv.json"))},JSON.stringify(process.argv.slice(2))); process.stdout.write("GNU bash, version 5.2.21(1)-release");`,
    );
    executable(
        dir,
        "jq",
        `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(join(dir, "jq-argv.json"))},JSON.stringify(process.argv.slice(2))); process.stdout.write("jq-1.8.1");`,
    );
    const h = await checkLocalDependencies(
        { ...config, usageDir: dir },
        {
            env: {
                PATH: dir,
                BASH_ENV: "private-canary",
                ENV: "private-canary",
                AWS_SECRET_ACCESS_KEY: "private-canary",
                BASH_FUNC_fixture: "private-canary",
            },
            nodeVersion: "22.19.0",
        },
    );
    assert.equal(h.node.status, "ready");
    assert.deepEqual(h.aws, { status: "ready", version: "2.22.1" });
    assert.equal(h.bash.status, "ready");
    assert.equal(h.jq.status, "ready");
    assert.equal(h.usage, true);
    const call = JSON.parse(readFileSync(marker, "utf8"));
    assert.deepEqual(call.args, ["--version"]);
    assert.deepEqual(call.env, {
        PATH: dir,
        LANG: "C",
        LC_ALL: "C",
        AWS_CLI_AUTO_PROMPT: "off",
        AWS_PAGER: "",
        NO_COLOR: "1",
    });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "bash-argv.json"), "utf8")), [
        "--noprofile",
        "--norc",
        "--version",
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "jq-argv.json"), "utf8")), ["--version"]);
    assert.equal(existsSync(join(dir, "usage-was-executed")), false);
    assert.doesNotMatch(JSON.stringify(h) + dependencyLines(h).join("\n"), /private-canary|Python|aws-cli\//);
});
test("dependency floors detect old Node, AWS CLI and Bash and apply usage program's jq floor only to macOS", async (t) => {
    const dir = fixtures(t, { aws: "1.42.1", bash: "3.2.57", jq: "1.7" });
    const mac = await checkLocalDependencies(config, {
        env: { PATH: dir },
        nodeVersion: "22.18.0",
        platform: "darwin",
    });
    for (const key of ["node", "aws", "bash", "jq"] as const) assert.equal(mac[key].status, "old");
    const linux = await checkLocalDependencies(config, {
        env: { PATH: dir },
        nodeVersion: "24.15.0",
        platform: "linux",
    });
    assert.equal(linux.node.status, "ready");
    assert.equal(linux.jq.status, "ready");
    assert.match(dependencyLines(linux).join("\n"), /no documented Linux version floor/);
    executable(dir, "aws", 'process.stdout.write("aws-cli/2.21.9");');
    const olderV2 = await checkLocalDependencies(config, { env: { PATH: dir } });
    assert.equal(olderV2.aws.status, "ready");
    assert.match(dependencyLines(olderV2).join("\n"), /usage program.*2.22/);
});
test("missing, failed and unrecognized local checks report closed categories without raw output", async (t) => {
    const dir = directory(t);
    executable(dir, "aws", 'process.stderr.write("private-canary-access-token"); process.exit(7);');
    executable(dir, "bash", 'process.stdout.write("private-canary-version");');
    const h = await checkLocalDependencies(config, { env: { PATH: dir }, nodeVersion: "private-canary" });
    assert.equal(h.aws.status, "unavailable");
    assert.equal(h.bash.status, "unrecognized");
    assert.equal(h.jq.status, "missing");
    assert.equal(h.node.status, "unrecognized");
    assert.equal(h.usage, false);
    assert.doesNotMatch(JSON.stringify(h) + dependencyLines(h).join("\n"), /private-canary|access-token/);
});
test("version checks bound the combined stdout and stderr bytes", async (t) => {
    const dir = fixtures(t);
    executable(
        dir,
        "aws",
        'process.stdout.write("x".repeat(8193)); process.stderr.write("private-canary" + "x".repeat(8193));',
    );
    const h = await checkLocalDependencies(config, { env: { PATH: dir } });
    assert.equal(h.aws.status, "overflow");
    assert.doesNotMatch(JSON.stringify(h), /private-canary|xxxx/);
});
/** A child process stand-in: the probe gets events it can drive, and kill() is recorded instead of signaling a PID. */
function fakeChildren() {
    const children: any[] = [];
    const spawnImpl = (() => {
        const child: any = new EventEmitter();
        child.pid = 900_000 + children.length;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = 0;
        child.kill = () => {
            child.killed++;
        };
        children.push(child);
        return child;
    }) as any;
    return { spawn: spawnImpl, children };
}

/** Runs the timeout callback on the next microtask, so a test never waits on a wall clock. */
const now = (fn: () => void) => {
    queueMicrotask(fn);
    return () => {};
};

const cancelledHealth = {
    node: { status: "cancelled" as const },
    aws: { status: "cancelled" as const },
    bash: { status: "cancelled" as const },
    jq: { status: "cancelled" as const },
    usage: false,
    platform: "linux" as const,
};

test("version checks time out and kill the child, with no wall clock", async () => {
    const fake = fakeChildren();
    const h = await checkLocalDependencies(config, {
        env: { PATH: "/nonexistent" },
        timeout: 10,
        spawn: fake.spawn,
        timer: now,
    });
    assert.equal(h.aws.status, "timeout");
    assert.equal(fake.children.length, 3, "one child per tool");
    assert.ok(
        fake.children.every((child) => child.killed > 0),
        "every probe is killed",
    );
    assert.doesNotMatch(JSON.stringify(h), /private-canary/);
});

test("abort cancels active local checks and a pre-aborted request launches no executable", async () => {
    const fake = fakeChildren();
    const controller = new AbortController();
    const pending = checkLocalDependencies(config, {
        env: { PATH: "/nonexistent" },
        spawn: fake.spawn,
        timer: () => () => {},
        signal: controller.signal,
    });
    controller.abort();
    const h = await pending;
    assert.equal(h.aws.status, "cancelled");
    assert.equal(h.bash.status, "cancelled");
    assert.equal(h.jq.status, "cancelled");
    assert.ok(
        fake.children.every((child) => child.killed > 0),
        "the child that started is killed",
    );
    const before = fake.children.length;
    const cancelled = await checkLocalDependencies(config, {
        env: { PATH: "/nonexistent" },
        spawn: fake.spawn,
        signal: controller.signal,
    });
    assert.equal(cancelled.aws.status, "cancelled");
    assert.equal(cancelled.bash.status, "cancelled");
    assert.equal(cancelled.jq.status, "cancelled");
    assert.equal(fake.children.length, before, "a pre-aborted request starts nothing");
});

for (const action of ["dialog close", "session shutdown"] as const)
    test(`doctor ${action} cancels local probes without model messages or usage program calls`, async (t) => {
        const dir = directory(t);
        const commands = new Map<string, any>(),
            hooks = new Map<string, Hook>();
        let started = 0,
            aborted = 0;
        let markStarted: () => void = () => {};
        const startedPromise = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const pi: any = {
            registerCommand: (name: string, command: any) => commands.set(name, command),
            on: (name: string, handler: Hook) => hooks.set(name, handler),
            sendMessage: () => assert.fail("No model message"),
            sendUserMessage: () => assert.fail("No user message"),
        };
        registerStatisticsCommands(pi, {
            config: { ...config, usageDir: dir },
            statistics: {
                load: () => undefined,
                health: () => {
                    assert.fail("No presence-only health shortcut");
                },
                refresh: async () => {
                    assert.fail("No usage program request");
                },
            },
            catalog: { load: () => undefined, refresh: async () => "ok" },
            models: () => [],
            budget: { load: () => undefined, refresh: async () => undefined },
            publish: () => assert.fail("No provider event"),
            check: (_config, options) =>
                new Promise((resolve) => {
                    started++;
                    markStarted();
                    options.signal?.addEventListener(
                        "abort",
                        () => {
                            aborted++;
                            resolve(cancelledHealth);
                        },
                        { once: true },
                    );
                }),
        });
        await commands.get("bedrock-doctor").handler("", {
            mode: "tui",
            ui: {
                notify: () => assert.fail("No notification"),
                custom: (factory: any) =>
                    new Promise<void>((resolve) => {
                        const component = factory(
                            { terminal: { rows: 20 }, requestRender() {} },
                            { fg: (_role: string, value: string) => value },
                            {},
                            resolve,
                        );
                        void startedPromise.then(() =>
                            queueMicrotask(() =>
                                action === "dialog close"
                                    ? component.handleInput("q")
                                    : hooks.get("session_shutdown")!(),
                            ),
                        );
                    }),
            },
        });
        assert.equal(started, 1, "the probes started");
        assert.equal(aborted, 1, "closing the dialog aborted them");
    });

for (const action of ["context abort", "session shutdown"] as const)
    test(`RPC doctor ${action} cancels probes and suppresses a late notification`, async (t) => {
        const controller = new AbortController();
        const commands = new Map<string, any>(),
            hooks = new Map<string, Hook>(),
            notifications: string[] = [];
        let started = 0,
            aborted = 0;
        let markStarted: () => void = () => {};
        const startedPromise = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const pi: any = {
            registerCommand: (name: string, command: any) => commands.set(name, command),
            on: (name: string, handler: Hook) => hooks.set(name, handler),
        };
        registerStatisticsCommands(pi, {
            config,
            statistics: {
                load: () => undefined,
                health: () => ({ usage: false, aws: false, bash: false, jq: false }),
                refresh: async () => {
                    assert.fail("No usage program request");
                },
            },
            catalog: { load: () => undefined, refresh: async () => "ok" },
            models: () => [],
            budget: { load: () => undefined, refresh: async () => undefined },
            publish() {},
            check: (_config, options) =>
                new Promise((resolve) => {
                    started++;
                    markStarted();
                    options.signal?.addEventListener(
                        "abort",
                        () => {
                            aborted++;
                            resolve(cancelledHealth);
                        },
                        { once: true },
                    );
                }),
        });
        const ctx: any = {
            mode: "rpc",
            signal: controller.signal,
            ui: { notify: (text: string) => notifications.push(text) },
        };
        await commands.get("bedrock-doctor").handler("--profile another", ctx);
        assert.match(notifications.pop()!, /Usage:/);
        assert.equal(started, 0, "a bad argument starts no probes");
        const pending = commands.get("bedrock-doctor").handler("", ctx);
        await startedPromise;
        if (action === "context abort") controller.abort();
        else hooks.get("session_shutdown")!();
        await pending;
        assert.equal(aborted, 1);
        assert.equal(notifications.length, 0);
    });
