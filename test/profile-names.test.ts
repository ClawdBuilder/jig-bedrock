// The profile list comes from the AWS config and credentials files, in file order, with no AWS CLI and no value in the answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listProfileNames } from "../src/aws-config-read.ts";
import { createListProfiles } from "../src/profile.ts";

function folder(t: test.TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "jig-bedrock-names-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("the config's default and profile sections come first, then the credentials file's, each name once", (t) => {
    const dir = folder(t);
    writeFileSync(
        join(dir, "config"),
        [
            "# a comment",
            "[default]",
            "region = us-east-1",
            "[profile work]",
            "sso_session = s",
            "[sso-session s]",
            "sso_start_url = https://example.invalid/start",
            "[services private]",
            "[profile  spaced ]",
            "[profile work]",
            "; another comment",
            "[plugins]",
        ].join("\n"),
    );
    writeFileSync(
        join(dir, "credentials"),
        ["[work]", "aws_access_key_id = AKIAFIXTURE", "[keys-only]", "aws_secret_access_key = secret-canary"].join(
            "\n",
        ),
    );
    const names = listProfileNames({
        AWS_CONFIG_FILE: join(dir, "config"),
        AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    });
    assert.deepEqual(names, ["default", "work", "spaced", "keys-only"]);
    assert.doesNotMatch(JSON.stringify(names), /AKIAFIXTURE|secret-canary|example\.invalid/);
});

test("a missing file is an empty list, not an error", (t) => {
    const dir = folder(t);
    assert.deepEqual(
        listProfileNames({ AWS_CONFIG_FILE: join(dir, "none"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "nothing") }),
        [],
    );
    writeFileSync(join(dir, "credentials"), "[only-here]\n");
    assert.deepEqual(
        listProfileNames({ AWS_CONFIG_FILE: join(dir, "none"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials") }),
        ["only-here"],
    );
});

test("without the two variables the files are under HOME/.aws", () => {
    const seen: string[] = [];
    listProfileNames({ HOME: "/home/user" }, (file) => {
        seen.push(file);
        return undefined;
    });
    assert.deepEqual(seen, ["/home/user/.aws/config", "/home/user/.aws/credentials"]);
});

test("createListProfiles answers the same names through the ListProfiles type", async (t) => {
    const dir = folder(t);
    writeFileSync(join(dir, "config"), "[profile a]\n[profile b]\n");
    const list = createListProfiles({
        AWS_CONFIG_FILE: join(dir, "config"),
        AWS_SHARED_CREDENTIALS_FILE: join(dir, "none"),
    });
    assert.deepEqual(await list(), ["a", "b"]);
});
