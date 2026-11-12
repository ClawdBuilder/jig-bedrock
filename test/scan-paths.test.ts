// The public scan must catch a machine path but allow the placeholders pages use in examples.
import assert from "node:assert/strict";
import test from "node:test";
import { hasMachinePath } from "../scripts/scan-company-strings.mjs";

const at = (prefix: string, name: string, tail: string) => `${prefix}${name}${tail}`;

test("a planted machine path fails the scan", () => {
    assert.equal(hasMachinePath(at("/home/", "alice", "/project")), true);
    assert.equal(hasMachinePath(at("/Users/", "alice", "/project")), true);
    assert.equal(hasMachinePath(`C:${"\\Users\\"}alice\\project`), true);
    assert.equal(hasMachinePath(`x/.nvm/${"versions/node/"}v26/bin/pi`), true);
    assert.equal(hasMachinePath("/tmp/" + "claude-check/file"), true);
});

test("the obvious placeholders pass", () => {
    for (const name of ["me", "you", "user", "<user>"]) {
        assert.equal(hasMachinePath(at("/home/", name, "/project")), false, name);
        assert.equal(hasMachinePath(at("/Users/", name, "/project")), false, name);
        assert.equal(hasMachinePath(`C:${"\\Users\\"}${name}\\project`), false, name);
    }
});
