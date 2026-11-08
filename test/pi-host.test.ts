// Where Pi is installed, and the AWS SDK found beside it. All on folders the tests build: no real Pi install is read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { findPiHost, loadCredentialProvider } from "../src/pi-host.ts";

describe("Pi's install", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A global npm prefix: `lib/node_modules/@earendil-works/pi-coding-agent` with its bundle, and `bin/pi` linked to it. */
    function prefix(name = "@earendil-works/pi-coding-agent") {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bedrock-pi-host-")));
        dirs.push(root);
        const host = path.join(root, "lib/node_modules/@earendil-works/pi-coding-agent");
        mkdirSync(path.join(host, "dist/bundle"), { recursive: true });
        writeFileSync(path.join(host, "package.json"), JSON.stringify({ name }));
        writeFileSync(path.join(host, "dist/bundle/cli.js"), "");
        mkdirSync(path.join(root, "bin"));
        symlinkSync(path.join(host, "dist/bundle/cli.js"), path.join(root, "bin/pi"));
        return { root, host, node: path.join(root, "bin/node"), pi: path.join(root, "bin/pi") };
    }

    test("PI_HOST_DIR wins, as it is", () => {
        const { node, pi } = prefix();
        assert.equal(findPiHost({ PI_HOST_DIR: "/somewhere/else" }, node, pi), "/somewhere/else");
    });

    test("is the folder above the pi script Node started, with links followed", () => {
        const { host, node, pi } = prefix();
        assert.equal(findPiHost({}, "/usr/bin/node", pi), host);
        assert.equal(findPiHost({}, node, pi), host);
    });

    test("is the global install beside this Node when the script says nothing, as the old check did", () => {
        const { host, node } = prefix();
        assert.equal(findPiHost({}, node, "/does/not/exist"), host);
        assert.equal(findPiHost({}, node, undefined), host);
    });

    test("is nothing when no package above the script, nor beside Node, is Pi", () => {
        const other = prefix("some-other-package");
        assert.equal(findPiHost({}, other.node, other.pi), undefined);
        assert.equal(findPiHost({}, "/nowhere/bin/node", "/nowhere/bin/pi"), undefined);
    });

    test("loads the SDK's defaultProvider from there, and refuses with no install", async () => {
        const { host } = prefix();
        const sdk = path.join(host, "node_modules/@aws-sdk/credential-provider-node");
        mkdirSync(sdk, { recursive: true });
        writeFileSync(
            path.join(sdk, "package.json"),
            JSON.stringify({ name: "@aws-sdk/credential-provider-node", main: "index.js" }),
        );
        writeFileSync(
            path.join(sdk, "index.js"),
            "exports.defaultProvider = (init) => () => Promise.resolve(init.profile);\n",
        );
        const provider = loadCredentialProvider(host);
        assert.equal(typeof provider, "function");
        assert.equal(await provider({ profile: "fixture" })(), "fixture");
        assert.throws(() => loadCredentialProvider(undefined), /Pi's install was not found/);
        assert.throws(() => loadCredentialProvider(prefix().host), /Cannot find module/, "an install without the SDK");
    });
});
