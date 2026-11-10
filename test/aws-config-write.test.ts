// Writing ~/.aws/config: the file is shared and hand-edited, so append only, keep every existing byte (comments and unknown
// sections), respect AWS_CONFIG_FILE, keep the mode, write atomically, and leave a backup. Credentials are never touched.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderSections, writeAwsConfig } from "../src/aws-config-write.ts";

const original = `# shared config, hand edited
[profile existing]
region = us-east-1
output = json

# keep this comment with the old session
[sso-session old]
sso_region = us-east-1
sso_start_url = https://old.example/start
`;

function fixture(mode = 0o640): { dir: string; env: NodeJS.ProcessEnv; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-aws-config-"));
    const file = join(dir, "config");
    writeFileSync(file, original, { mode });
    return { dir, env: { HOME: dir, AWS_CONFIG_FILE: file }, file };
}

const ssoSections = [
    {
        header: "profile team-sso",
        entries: [
            ["sso_session", "team"],
            ["sso_account_id", "123456789012"],
            ["sso_role_name", "ReadOnly"],
            ["region", "us-east-1"],
        ] as Array<[string, string]>,
    },
    {
        header: "sso-session team",
        entries: [
            ["sso_region", "us-east-1"],
            ["sso_start_url", "https://my-sso-portal.awsapps.com/start"],
        ] as Array<[string, string]>,
    },
];

test("renderSections shows exactly the lines that will be added", () => {
    assert.equal(
        renderSections(ssoSections),
        [
            "[profile team-sso]",
            "sso_session = team",
            "sso_account_id = 123456789012",
            "sso_role_name = ReadOnly",
            "region = us-east-1",
            "",
            "[sso-session team]",
            "sso_region = us-east-1",
            "sso_start_url = https://my-sso-portal.awsapps.com/start",
        ].join("\n"),
    );
});

test("appending keeps every existing byte, the file mode, and makes a backup", () => {
    const { dir, env, file } = fixture();
    try {
        const result = writeAwsConfig(env, ssoSections);
        assert.equal(result.written, true);
        assert.equal(result.file, file);
        assert.ok(result.backup);
        const after = readFileSync(file, "utf8");
        assert.ok(after.startsWith(original), "comments and unknown sections are untouched");
        assert.match(after.slice(original.length), /^\n\[profile team-sso\]/);
        assert.match(after, /\[sso-session team\]\nsso_region = us-east-1/);
        assert.equal(readFileSync(result.backup, "utf8"), original);
        assert.equal(statSync(file).mode & 0o777, 0o640);
        assert.equal(statSync(result.backup).mode & 0o777, 0o640);
        assert.equal(
            readdirSync(dir).some((name) => name.endsWith(".tmp")),
            false,
            "no temporary file is left",
        );
        assert.equal(existsSync(join(dir, ".aws", "credentials")), false, "credentials are not created");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a role profile appends only its profile section", () => {
    const { dir, env, file } = fixture();
    try {
        const result = writeAwsConfig(env, [
            {
                header: "profile team-role",
                entries: [
                    ["role_arn", "arn:aws:iam::123456789012:role/ReadOnly"],
                    ["source_profile", "existing"],
                    ["region", "us-east-1"],
                ],
            },
        ]);
        assert.equal(result.written, true);
        const after = readFileSync(file, "utf8");
        assert.ok(after.startsWith(original));
        assert.match(after, /\[profile team-role\]\nrole_arn = .*\nsource_profile = existing\nregion = us-east-1\n$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an existing profile or session is refused before anything is written", () => {
    const { dir, env, file } = fixture();
    try {
        const result = writeAwsConfig(env, [{ header: "profile existing", entries: [["region", "eu-west-1"]] }]);
        assert.equal(result.written, false);
        assert.match(result.error ?? "", /\[profile existing\] already exists/);
        assert.equal(readFileSync(file, "utf8"), original);
        assert.equal(existsSync(`${file}.jig-bedrock.bak`), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a new AWS_CONFIG_FILE is created privately, with no backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-aws-config-new-"));
    const file = join(dir, "nested", "config");
    try {
        const result = writeAwsConfig({ HOME: dir, AWS_CONFIG_FILE: file }, [
            { header: "profile keys", entries: [["region", "us-east-1"]] },
        ]);
        assert.equal(result.written, true);
        assert.equal(result.backup, undefined);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.match(readFileSync(file, "utf8"), /^\[profile keys\]\nregion = us-east-1\n$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
