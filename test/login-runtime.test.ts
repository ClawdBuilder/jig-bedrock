import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRecovery, ssoRuntime } from "../src/login.ts";
import { SsoRecoveryError, shareRecovery } from "../src/sso.ts";
import { elsewhere } from "./support/wsl.ts";

test("missing or unsafe inherited runtime uses an owned private home fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "sso-runtime-"));
    try {
        const missing = join(home, "missing/run/user/1000");
        const fallback = ssoRuntime({ HOME: home, XDG_RUNTIME_DIR: missing });
        assert.equal(existsSync(missing), false);
        assert.equal(lstatSync(fallback).mode & 0o777, 0o700);
        const unsafe = join(home, "unsafe");
        mkdirSync(unsafe, { mode: 0o777 });
        chmodSync(unsafe, 0o777);
        assert.equal(ssoRuntime({ HOME: home, XDG_RUNTIME_DIR: unsafe }), fallback);
        const alias = join(home, "alias");
        symlinkSync(fallback, alias);
        assert.equal(ssoRuntime({ HOME: home, XDG_RUNTIME_DIR: alias }), fallback);
        assert.throws(() => ssoRuntime({ HOME: join(home, "absent") }), /runtime/);
        chmodSync(fallback, 0o755);
        assert.throws(() => ssoRuntime({ HOME: home }), /runtime/);
        assert.equal(lstatSync(fallback).mode & 0o777, 0o755, "Do not repair unsafe permissions");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("standalone default recovery hands a usable XDG directory to the browser helper after reboot", async () => {
    const home = mkdtempSync(join(tmpdir(), "sso-login-"));
    const previous = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
    try {
        process.env.HOME = home;
        process.env.XDG_RUNTIME_DIR = join(home, "missing/run/user/1000");
        const script = join(home, "login.sh");
        writeFileSync(
            script,
            '#!/bin/sh\n[ -d "$XDG_RUNTIME_DIR" ] || exit 1\ntouch "$HOME/browser-invoked"\necho https://private.invalid/device-code\n',
        );
        const recover = createRecovery({ ssoLoginCommand: ["/bin/sh", script, "{profile}"] } as any, {
            wsl: elsewhere,
        });
        await recover("fixture");
        assert.equal(existsSync(join(home, "browser-invoked")), true);
        assert.equal(existsSync(process.env.XDG_RUNTIME_DIR), false);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
});

test("warmup/manual/request share one flight; cancellation only stops it after all subscribers leave", async () => {
    let calls = 0,
        stopped = 0,
        finish!: () => void;
    const recover = shareRecovery(async (_profile, signal) => {
        calls++;
        await new Promise<void>((resolve, reject) => {
            finish = resolve;
            signal?.addEventListener(
                "abort",
                () => {
                    stopped++;
                    reject(new Error("private-helper-canary"));
                },
                { once: true },
            );
        });
    });
    const warmup = new AbortController(),
        request = new AbortController();
    const a = recover("fixture", warmup.signal, "warmup");
    const b = recover("fixture", request.signal, "request");
    const c = recover("fixture", undefined, "manual");
    await Promise.resolve();
    warmup.abort();
    await assert.rejects(a, /cancelled/);
    assert.equal(calls, 1);
    assert.equal(stopped, 0);
    finish();
    await Promise.all([b, c]);
    const controller = new AbortController();
    const abandoned = recover("fixture", controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(abandoned, /cancelled/);
    assert.equal(stopped, 1);
});

test("shared failures contain only a category and identify the terminal stream owner", async () => {
    const recover = shareRecovery(async () => {
        throw new Error("https://private.invalid/device-code");
    });
    const result = await Promise.allSettled([
        recover("fixture", undefined, "warmup"),
        recover("fixture", undefined, "request"),
    ]);
    for (const item of result) {
        assert.equal(item.status, "rejected");
        if (item.status === "rejected") {
            assert.ok(item.reason instanceof SsoRecoveryError);
            assert.equal(item.reason.streamed, true);
            assert.equal(item.reason.category, "login");
            assert.doesNotMatch(item.reason.message, /private|https/);
        }
    }
});

test("a new login can start immediately after the last caller cancels", async () => {
    let calls = 0;
    const recover = shareRecovery(async (_profile, signal) => {
        if (++calls > 1) return;
        await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(new SsoRecoveryError("cancelled")), { once: true }),
        );
    });
    const controller = new AbortController(),
        first = recover("fixture", controller.signal);
    await Promise.resolve();
    controller.abort();
    const next = recover("fixture");
    await assert.rejects(first, /cancelled/);
    await next;
    assert.equal(calls, 2);
});
