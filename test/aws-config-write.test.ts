// Writing ~/.aws/config: the file is shared and hand-edited, so append only, keep every existing byte (comments and unknown
// sections), respect AWS_CONFIG_FILE, keep the mode, write atomically through a link, hold a lock, and leave timestamped
// backups (five at most). Credentials are never touched.
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
        assert.match(basename(result.backup), /^config\.jig-bedrock-backup-\d{8}T\d{6}Z$/);
        assert.equal(readFileSync(result.backup, "utf8"), original);
        assert.equal(statSync(file).mode & 0o777, 0o640);
        assert.equal(statSync(result.backup).mode & 0o777, 0o640);
        assert.deepEqual(
            readdirSync(dir).sort(),
            ["config", basename(result.backup)],
            "no temporary file and no lock are left",
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
        assert.deepEqual(readdirSync(dir), ["config"], "no backup and no lock are left");
        assert.equal(existsSync(`${file}.jig-bedrock.lock`), false);
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

const oneSection = (name: string) => [
    { header: `profile ${name}`, entries: [["region", "us-east-1"]] as Array<[string, string]> },
];
const backups = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("config.jig-bedrock-backup-"));
const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 10, 17, minute, 0));

test("each write makes a new backup of the text before it; the first backup is kept", () => {
    const { dir, env, file } = fixture();
    try {
        const first = writeAwsConfig(env, oneSection("one"), at(15));
        const afterFirst = readFileSync(file, "utf8");
        const second = writeAwsConfig(env, oneSection("two"), at(16));
        assert.equal(basename(first.backup ?? ""), "config.jig-bedrock-backup-20261110T171500Z");
        assert.equal(basename(second.backup ?? ""), "config.jig-bedrock-backup-20261110T171600Z");
        assert.equal(readFileSync(first.backup ?? "", "utf8"), original, "the first backup still holds the first text");
        assert.equal(readFileSync(second.backup ?? "", "utf8"), afterFirst);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("two writes in the same second do not replace each other's backup", () => {
    const { dir, env } = fixture();
    try {
        const first = writeAwsConfig(env, oneSection("one"), at(15));
        const second = writeAwsConfig(env, oneSection("two"), at(15));
        assert.notEqual(first.backup, second.backup);
        assert.equal(backups(dir).length, 2);
        assert.equal(readFileSync(first.backup ?? "", "utf8"), original);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the sixth write removes the oldest backup, and only this package's backups are touched", () => {
    const { dir, env } = fixture();
    try {
        const others = [
            "config.jig-bedrock.bak",
            "config.jig-bedrock-backup-notes",
            "config.backup",
            "config.jig-bedrock-backup-20200101T000000Z.keep",
        ];
        for (const name of others) writeFileSync(join(dir, name), "mine");
        const ours = () =>
            backups(dir)
                .filter((name) => !others.includes(name))
                .sort();
        const made: string[] = [];
        for (let minute = 0; minute < 5; minute++) {
            made.push(basename(writeAwsConfig(env, oneSection(`p${minute}`), at(minute)).backup ?? ""));
        }
        assert.deepEqual(ours(), made, "five writes, five backups");
        made.push(basename(writeAwsConfig(env, oneSection("p5"), at(5)).backup ?? ""));
        assert.deepEqual(ours(), made.slice(1), "the sixth write removed the oldest and only the oldest");
        made.push(basename(writeAwsConfig(env, oneSection("p6"), at(6)).backup ?? ""));
        assert.deepEqual(ours(), made.slice(2), "and the seventh the next oldest");
        for (const name of others) assert.equal(readFileSync(join(dir, name), "utf8"), "mine", name);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a symlinked config stays a symlink, and its target gets the new section", () => {
    const { dir, env, file } = fixture();
    try {
        const real = join(dir, "dotfiles", "aws-config");
        mkdirSync(join(dir, "dotfiles"));
        writeFileSync(real, original, { mode: 0o640 });
        rmSync(file);
        symlinkSync(real, file);
        const result = writeAwsConfig(env, oneSection("linked"));
        assert.equal(result.written, true);
        assert.equal(result.file, file);
        assert.equal(lstatSync(file).isSymbolicLink(), true, "the link is still a link");
        assert.equal(realpathSync(file), realpathSync(real));
        assert.ok(readFileSync(real, "utf8").startsWith(original));
        assert.match(readFileSync(real, "utf8"), /\[profile linked\]\nregion = us-east-1\n$/);
        assert.equal(statSync(real).mode & 0o777, 0o640);
        assert.equal(dirname(result.backup ?? ""), join(dir, "dotfiles"), "backup and lock live beside the real file");
        assert.deepEqual(readdirSync(dir).sort(), ["config", "dotfiles"]);
        assert.equal(
            readdirSync(join(dir, "dotfiles")).length,
            2,
            "the file and one backup; no temporary file, no lock",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a link to a file that does not exist yet creates the target, not a replacement for the link", () => {
    const { dir, env, file } = fixture();
    try {
        const real = join(dir, "later");
        rmSync(file);
        symlinkSync("later", file);
        const result = writeAwsConfig(env, oneSection("fresh"));
        assert.equal(result.written, true);
        assert.equal(lstatSync(file).isSymbolicLink(), true);
        assert.match(readFileSync(real, "utf8"), /^\[profile fresh\]/);
        assert.equal(statSync(real).mode & 0o777, 0o600);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a lock held by a live writer refuses the write and changes nothing", () => {
    const { dir, env, file } = fixture();
    try {
        const lock = `${file}.jig-bedrock.lock`;
        writeFileSync(lock, "12345 2026-11-10T17:15:00.000Z\n");
        const before = readdirSync(dir).sort();
        const result = writeAwsConfig(env, oneSection("blocked"));
        assert.equal(result.written, false);
        assert.equal(result.error, `Another program is changing ${file}; try again.`);
        assert.equal(readFileSync(file, "utf8"), original);
        assert.deepEqual(readdirSync(dir).sort(), before, "no backup, and the other writer's lock stays");
        assert.equal(readFileSync(lock, "utf8"), "12345 2026-11-10T17:15:00.000Z\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a lock older than 30 seconds is taken over, and the lock is gone afterwards", () => {
    const { dir, env, file } = fixture();
    try {
        const lock = `${file}.jig-bedrock.lock`;
        writeFileSync(lock, "12345 2026-11-10T17:00:00.000Z\n");
        const old = new Date(Date.now() - 31_000);
        utimesSync(lock, old, old);
        const result = writeAwsConfig(env, oneSection("taken"));
        assert.equal(result.written, true);
        assert.match(readFileSync(file, "utf8"), /\[profile taken\]/);
        assert.equal(existsSync(lock), false);
        // A lock that is 25 seconds old is still a live writer's.
        writeFileSync(lock, "12345 2026-11-10T17:00:00.000Z\n");
        const recent = new Date(Date.now() - 25_000);
        utimesSync(lock, recent, recent);
        assert.equal(writeAwsConfig(env, oneSection("again")).written, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the lock is removed when the write is refused or fails", () => {
    const { dir, env, file } = fixture();
    try {
        // A duplicate section fails after the lock is taken: the lock must not outlive the call.
        assert.equal(writeAwsConfig(env, [{ header: "profile existing", entries: [] }]).written, false);
        assert.equal(existsSync(`${file}.jig-bedrock.lock`), false);
        // The folder cannot be written: the write fails and leaves nothing of its own.
        chmodSync(dir, 0o500);
        const result = writeAwsConfig(env, oneSection("denied"));
        chmodSync(dir, 0o700);
        if (process.getuid?.() !== 0) {
            assert.equal(result.written, false);
            assert.match(result.error ?? "", /could not be written/);
            assert.deepEqual(readdirSync(dir), ["config"]);
        }
    } finally {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("file modes: an existing config keeps its mode on the file and its backup, a new file is 0600", () => {
    for (const mode of [0o600, 0o644]) {
        const { dir, env, file } = fixture(mode);
        try {
            chmodSync(file, mode);
            const result = writeAwsConfig(env, oneSection("modes"));
            assert.equal(statSync(file).mode & 0o777, mode);
            assert.equal(statSync(result.backup ?? "").mode & 0o777, mode);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});
