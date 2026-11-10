// The guided /login flow: each way of answering AWS, verification, discovery choices, and the rule that no prompt ever
// asks for a secret. The AWS CLI owns credentials; the returned credential holds only AWS_PROFILE (or nothing for chain).
import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigSection } from "../src/aws-config-write.ts";
import { type LoginFlowOptions, runLoginFlow } from "../src/login-flow.ts";
import type { DiscoverySettings, SaveDiscoveryResult } from "../src/settings-write.ts";

interface Prompt {
    type: string;
    message?: string;
    options?: readonly { id: string; label: string }[];
}

const isGuidance = (prompt: Prompt): boolean =>
    prompt.message?.includes("Run this in a terminal") === true ||
    prompt.message?.includes("Add a profile to ~/.aws/config") === true;

function interaction(respond: (prompt: Prompt) => string) {
    const controller = new AbortController();
    const prompts: Prompt[] = [];
    const notices: Array<{ type: string; message?: string }> = [];
    return {
        controller,
        prompts,
        notices,
        value: {
            signal: controller.signal,
            prompt: async (prompt: Prompt) => {
                prompts.push({ type: prompt.type, message: prompt.message, options: prompt.options });
                return respond(prompt);
            },
            notify: (event: { type: string; message?: string }) => notices.push(event),
        },
    };
}

function options(overrides: Partial<LoginFlowOptions> = {}): LoginFlowOptions {
    return {
        listProfiles: async () => ["demo-sso", "keys", "role"],
        isSso: (profile) => profile === "demo-sso",
        verify: async () => ({ ok: true }),
        signIn: async () => {},
        saveDiscovery: () => ({ file: "/tmp/bedrock.json", written: true, shadowed: [] }),
        regions: ["us-east-1"],
        ...overrides,
    };
}

const profileAnswer = (name: string) => (prompt: Prompt) =>
    prompt.type === "text"
        ? ""
        : prompt.message?.includes("How do you sign in to AWS?")
          ? "existing"
          : prompt.message === "Which inference profiles should Bedrock list?"
            ? "system"
            : `profile:${name}`;

test("an existing profile is checked with AWS and returns only AWS_PROFILE", async () => {
    const fake = interaction(profileAnswer("keys"));
    const verified: Array<string | undefined> = [];
    const saved: DiscoverySettings[] = [];
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        verify: async (profile) => {
            verified.push(profile);
            return { ok: true };
        },
        saveDiscovery: (settings) => {
            saved.push(settings);
            return { file: "/tmp/bedrock.json", written: true, shadowed: [] };
        },
    });
    assert.deepEqual(verified, ["keys"]);
    assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "keys" } });
    assert.equal("key" in credential, false, "no secret field");
    assert.deepEqual(saved, [{ mode: "system", regions: ["us-east-1"] }]);
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /Looking up your AWS profiles…/);
});

test("access keys are set up in a terminal, then listed again and verified", async () => {
    const fake = interaction((prompt) =>
        isGuidance(prompt)
            ? "ready"
            : prompt.type === "text"
              ? ""
              : prompt.message?.includes("How do you sign in to AWS?")
                ? "keys"
                : prompt.message === "Which inference profiles should Bedrock list?"
                  ? "system"
                  : "profile:keys",
    );
    let refreshes = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        refreshProfiles: async () => {
            refreshes++;
            return ["keys"];
        },
    });
    assert.equal(refreshes, 1);
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
    assert.match(fake.prompts.map((prompt) => prompt.message ?? "").join("\n"), /aws configure --profile my-profile/);
});

test("a role profile is explained, then listed again and verified", async () => {
    const fake = interaction((prompt) =>
        isGuidance(prompt)
            ? "ready"
            : prompt.type === "text"
              ? ""
              : prompt.message?.includes("How do you sign in to AWS?")
                ? "role"
                : prompt.message === "Which inference profiles should Bedrock list?"
                  ? "system"
                  : "profile:role",
    );
    let refreshes = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        refreshProfiles: async () => {
            refreshes++;
            return ["role"];
        },
    });
    assert.equal(refreshes, 1);
    assert.deepEqual(credential.env, { AWS_PROFILE: "role" });
    assert.match(fake.prompts.map((prompt) => prompt.message ?? "").join("\n"), /role_arn = .*\n {2}source_profile = /);
});

test("access-key guidance waits for confirmation before listing, and the new profile appears", async () => {
    let profiles = ["old"];
    let refreshes = 0;
    const fake = interaction((prompt) => {
        if (isGuidance(prompt)) {
            profiles = [...profiles, "new-keys"];
            return "ready";
        }
        if (prompt.message?.includes("How do you sign in to AWS?")) return "keys";
        if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
        return "profile:new-keys";
    });
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        listProfiles: async () => profiles,
        refreshProfiles: async () => {
            refreshes++;
            return profiles;
        },
    });
    assert.equal(refreshes, 1, "the fresh listing happens only after the confirmation");
    const instruction = fake.prompts.find(isGuidance);
    assert.match(instruction?.message ?? "", /aws configure --profile my-profile/);
    assert.match(instruction?.message ?? "", /~\/.aws\/credentials/);
    const pick = fake.prompts.find((prompt) => prompt.message === "Which AWS profile should Bedrock use?");
    assert.deepEqual(
        pick?.options?.map((option) => option.id),
        ["profile:old", "profile:new-keys", "type"],
        "the profile created while the dialog waited is in the list",
    );
    assert.deepEqual(credential.env, { AWS_PROFILE: "new-keys" });
});

test("Back on the guidance returns to the methods without listing again", async () => {
    let methods = 0;
    let refreshes = 0;
    const fake = interaction((prompt) => {
        if (isGuidance(prompt)) return "back";
        if (prompt.message?.includes("How do you sign in to AWS?")) return methods++ === 0 ? "role" : "existing";
        if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
        return "profile:keys";
    });
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        listProfiles: async () => ["keys"],
        refreshProfiles: async () => {
            refreshes++;
            return ["keys"];
        },
    });
    assert.equal(refreshes, 0, "Back does not fetch the list");
    assert.equal(methods, 2, "the method list is shown again");
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
    const instruction = fake.prompts.find(isGuidance);
    assert.match(instruction?.message ?? "", /role_arn = /);
    assert.match(instruction?.message ?? "", /source_profile = /);
});

test("an SSO profile signs in first, then verifies, and only SSO profiles are listed", async () => {
    const fake = interaction((prompt) =>
        prompt.message?.includes("How do you sign in to AWS?")
            ? "sso"
            : prompt.message === "Which inference profiles should Bedrock list?"
              ? "system"
              : "profile:demo-sso",
    );
    const signed: string[] = [];
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        signIn: async (profile) => {
            signed.push(profile);
        },
    });
    assert.deepEqual(signed, ["demo-sso"]);
    assert.deepEqual(credential.env, { AWS_PROFILE: "demo-sso" });
    const optionsShown = fake.prompts.find(
        (prompt) => prompt.message === "Which AWS SSO profile do you want to sign in to?",
    );
    assert.ok(optionsShown);
});

test("a typed non-SSO profile is refused before any sign-in", async () => {
    let ssoAttempts = 0;
    const fake = interaction((prompt) => {
        if (prompt.message?.includes("How do you sign in to AWS?")) return "sso";
        if (prompt.message === "Which AWS SSO profile do you want to sign in to?") {
            ssoAttempts++;
            return ssoAttempts === 1 ? "type" : "profile:demo-sso";
        }
        if (prompt.message === "AWS profile name") return "keys";
        if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
        return "";
    });
    let signed = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        signIn: async () => {
            signed++;
        },
    });
    assert.equal(signed, 1, "the second, SSO attempt signs in");
    assert.deepEqual(credential.env, { AWS_PROFILE: "demo-sso" });
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /keys is not an IAM Identity Center/);
    assert.equal(ssoAttempts, 2);
});

test("the credential chain verifies with no profile and stores no profile", async () => {
    const fake = interaction((prompt) =>
        prompt.message?.includes("How do you sign in to AWS?")
            ? "chain"
            : prompt.message === "Which inference profiles should Bedrock list?"
              ? "system"
              : "",
    );
    const verified: Array<string | undefined> = [];
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        verify: async (profile) => {
            verified.push(profile);
            return { ok: true };
        },
    });
    assert.deepEqual(verified, [undefined]);
    assert.deepEqual(credential, { type: "api_key" });
});

test("a Bedrock API key is refused, and the flow offers the methods again", async () => {
    let method = 0;
    const fake = interaction((prompt) => {
        if (prompt.message?.includes("How do you sign in to AWS?")) return method++ === 0 ? "key" : "existing";
        if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
        return "profile:keys";
    });
    const credential = await runLoginFlow(fake.value as never, options());
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
    assert.match(
        fake.prompts.map((prompt) => prompt.message ?? "").join("\n"),
        /Use Pi's built-in Amazon Bedrock provider for an API key/,
        "the reason stays on screen in the next method prompt",
    );
});

test("a failed check says so and asks again", async () => {
    let attempt = 0;
    const fake = interaction((prompt) => {
        if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
        if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
        return "profile:keys";
    });
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        verify: async () => {
            attempt++;
            return attempt === 1 ? { ok: false, message: "AWS did not answer for keys." } : { ok: true };
        },
    });
    assert.equal(attempt, 2);
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /AWS did not answer for keys/);
});

test("tag and explicit discovery choices are saved with the regions", async () => {
    for (const [mode, answers] of [
        ["tag", ["Team", "my-team"]],
        [
            "explicit",
            [
                "arn:aws:bedrock:us-east-1:123456789012:inference-profile/a, arn:aws:bedrock:us-east-1:123456789012:inference-profile/b",
            ],
        ],
    ] as const) {
        const saved: DiscoverySettings[] = [];
        const fake = interaction((prompt) => {
            if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
            if (prompt.message === "Which inference profiles should Bedrock list?") return mode;
            if (prompt.message === "Tag key") return answers[0]!;
            if (prompt.message === "Tag value") return answers[1]!;
            if (prompt.message === "Profile ARNs or ids (comma separated)") return answers[0]!;
            if (prompt.message === "AWS regions for discovery (comma separated)") return "us-east-1, eu-west-1";
            return "profile:keys";
        });
        await runLoginFlow(fake.value as never, {
            ...options(),
            saveDiscovery: (settings) => {
                saved.push(settings);
                return { file: "/tmp/bedrock.json", written: true, shadowed: [] };
            },
        });
        assert.equal(saved.length, 1);
        assert.equal(saved[0]?.mode, mode);
        assert.deepEqual(saved[0]?.regions, ["us-east-1", "eu-west-1"]);
        if (mode === "tag") assert.deepEqual([saved[0]?.tagKey, saved[0]?.tagValue], ["Team", "my-team"]);
        else assert.equal(saved[0]?.profiles?.length, 2);
    }
});

test("no prompt ever asks for a secret and no credential carries a key", async () => {
    for (const method of ["existing", "sso", "keys", "role", "chain"]) {
        const fake = interaction((prompt) => {
            if (isGuidance(prompt)) return "ready";
            if (prompt.message?.includes("How do you sign in to AWS?")) return method;
            if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
            return method === "sso" ? "profile:demo-sso" : "profile:keys";
        });
        const credential = await runLoginFlow(fake.value as never, options());
        for (const prompt of fake.prompts) {
            assert.ok(prompt.type === "select" || prompt.type === "text", `${method}: prompt type ${prompt.type}`);
            assert.notEqual(prompt.type, "secret");
            // Guidance may name the key and say jig-bedrock never asks for it; no prompt may ask for it.
            assert.doesNotMatch(prompt.message ?? "", /enter (your |the )?(secret|access key)|secret access key:/i);
        }
        assert.equal("key" in credential, false);
        assert.doesNotMatch(JSON.stringify(credential), /secret|access.?key/i);
    }
});

const ssoAnswers =
    (overrides: Record<string, string> = {}) =>
    (prompt: Prompt): string => {
        const text = prompt.message ?? "";
        if (text.includes("How do you sign in to AWS?")) return "sso-new";
        if (text.includes("Add these lines")) return "write";
        if (text.includes("New AWS SSO profile name")) return overrides.name ?? "team-sso";
        if (text.includes("SSO session name")) return overrides.session ?? "team";
        if (text.includes("SSO start URL")) return overrides.url ?? "https://my-sso-portal.awsapps.com/start";
        if (text.includes("SSO region")) return overrides.ssoRegion ?? "us-east-1";
        if (text.includes("SSO account ID")) return overrides.account ?? "123456789012";
        if (text.includes("SSO role name")) return overrides.role ?? "ReadOnly";
        if (text.includes("AWS profile region")) return overrides.region ?? "us-east-1";
        if (text.includes("Which inference profiles should Bedrock list?")) return "system";
        if (text === "AWS regions for discovery (comma separated)") return "";
        return "";
    };

test("a new SSO profile shows its exact lines, writes only after confirmation, then signs in", async () => {
    const fake = interaction(ssoAnswers());
    const written: ConfigSection[][] = [];
    const signed: string[] = [];
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        configFile: "/tmp/aws-config",
        writeConfig: (sections) => {
            written.push(sections);
            return { file: "/tmp/aws-config", written: true, backup: "/tmp/aws-config.jig-bedrock.bak" };
        },
        signIn: async (profile) => {
            signed.push(profile);
        },
    });
    assert.deepEqual(signed, ["team-sso"]);
    assert.deepEqual(credential.env, { AWS_PROFILE: "team-sso" });
    assert.equal(written.length, 1);
    const rendered = JSON.stringify(written[0]);
    assert.match(rendered, /"header":"profile team-sso"/);
    assert.match(rendered, /"sso_account_id","123456789012"/);
    assert.match(rendered, /"header":"sso-session team"/);
    assert.match(rendered, /"sso_start_url","https:\/\/my-sso-portal.awsapps.com\/start"/);
    const confirm = fake.prompts.find((prompt) => prompt.message?.includes("Add these lines"));
    assert.match(confirm?.message ?? "", /Add these lines to \/tmp\/aws-config\?/);
    assert.match(confirm?.message ?? "", /\[profile team-sso\]\nsso_session = team/);
    assert.match(confirm?.message ?? "", /\[sso-session team\]\nsso_region = us-east-1/);
});

test("Back on the new SSO lines writes nothing and returns to the methods", async () => {
    let methods = 0;
    const fake = interaction((prompt) => {
        const text = prompt.message ?? "";
        if (text.includes("How do you sign in to AWS?")) return methods++ === 0 ? "sso-new" : "existing";
        if (text.includes("Add these lines")) return "back";
        if (text.includes("New AWS SSO profile name")) return "team-sso";
        if (text.includes("SSO session name")) return "team";
        if (text.includes("SSO start URL")) return "https://my-sso-portal.awsapps.com/start";
        if (text.includes("SSO region")) return "us-east-1";
        if (text.includes("SSO account ID")) return "123456789012";
        if (text.includes("SSO role name")) return "ReadOnly";
        if (text.includes("AWS profile region")) return "us-east-1";
        if (text.includes("Which inference profiles should Bedrock list?")) return "system";
        if (text === "AWS regions for discovery (comma separated)") return "";
        if (text === "Which AWS profile should Bedrock use?") return "profile:keys";
        return "";
    });
    let written = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        configFile: "/tmp/aws-config",
        writeConfig: () => {
            written++;
            return { file: "/tmp/aws-config", written: true };
        },
    });
    assert.equal(written, 0);
    assert.equal(methods, 2);
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
});

test("a bad SSO account ID is reported before anything is written", async () => {
    let methods = 0;
    const fake = interaction((prompt) => {
        if ((prompt.message ?? "").includes("How do you sign in to AWS?"))
            return methods++ === 0 ? "sso-new" : "existing";
        if (prompt.message === "Which AWS profile should Bedrock use?") return "profile:keys";
        if ((prompt.message ?? "").includes("Which inference profiles should Bedrock list?")) return "system";
        if (prompt.message === "AWS regions for discovery (comma separated)") return "";
        return ssoAnswers({ account: "12" })(prompt);
    });
    let written = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        configFile: "/tmp/aws-config",
        writeConfig: () => {
            written++;
            return { file: "/tmp/aws-config", written: true };
        },
    });
    assert.equal(written, 0);
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /12-digit AWS account ID/);
    assert.deepEqual(
        credential.env,
        { AWS_PROFILE: "keys" },
        "the flow goes back to the methods and can finish another way",
    );
});

test("a new role profile shows role_arn and source_profile, writes after confirmation, then verifies", async () => {
    const fake = interaction((prompt) => {
        const text = prompt.message ?? "";
        if (text.includes("How do you sign in to AWS?")) return "role-new";
        if (text.includes("Add these lines")) return "write";
        if (text.includes("New AWS role profile name")) return "team-role";
        if (text.includes("Role ARN")) return "arn:aws:iam::123456789012:role/ReadOnly";
        if (text.includes("source_profile")) return "profile:keys";
        if (text.includes("Role region")) return "us-east-1";
        if (text.includes("MFA serial number")) return "";
        if (text.includes("External ID")) return "";
        if (text.includes("Which inference profiles should Bedrock list?")) return "system";
        if (text === "AWS regions for discovery (comma separated)") return "";
        return "";
    });
    const written: ConfigSection[][] = [];
    const verified: Array<string | undefined> = [];
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        listProfiles: async () => ["keys", "role"],
        configFile: "/tmp/aws-config",
        writeConfig: (sections) => {
            written.push(sections);
            return { file: "/tmp/aws-config", written: true };
        },
        verify: async (profile) => {
            verified.push(profile);
            return { ok: true };
        },
    });
    assert.equal(written.length, 1);
    assert.deepEqual(written[0]?.[0]?.entries, [
        ["role_arn", "arn:aws:iam::123456789012:role/ReadOnly"],
        ["source_profile", "keys"],
        ["region", "us-east-1"],
    ]);
    assert.deepEqual(verified, ["team-role"]);
    assert.deepEqual(credential.env, { AWS_PROFILE: "team-role" });
});

test("a source profile that does not exist is refused before writing", async () => {
    let methods = 0;
    const fake = interaction((prompt) => {
        const text = prompt.message ?? "";
        if (text.includes("How do you sign in to AWS?")) return methods++ === 0 ? "role-new" : "existing";
        if (text.includes("New AWS role profile name")) return "team-role";
        if (text.includes("Role ARN")) return "arn:aws:iam::123456789012:role/ReadOnly";
        if (text.includes("source_profile")) return "type";
        if (text === "Source AWS profile name") return "missing-source";
        if (text === "Which AWS profile should Bedrock use?") return "profile:keys";
        if (text.includes("Which inference profiles should Bedrock list?")) return "system";
        if (text === "AWS regions for discovery (comma separated)") return "";
        return "";
    });
    let written = 0;
    const credential = await runLoginFlow(fake.value as never, {
        ...options(),
        listProfiles: async () => ["keys"],
        configFile: "/tmp/aws-config",
        writeConfig: () => {
            written++;
            return { file: "/tmp/aws-config", written: true };
        },
    });
    assert.equal(written, 0);
    assert.match(
        fake.notices.map((notice) => notice.message).join("\n"),
        /missing-source is not in aws configure list-profiles/,
    );
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
});

test("the new-profile questions never ask for a secret", async () => {
    const fake = interaction(ssoAnswers());
    await runLoginFlow(fake.value as never, {
        ...options(),
        configFile: "/tmp/aws-config",
        writeConfig: () => ({ file: "/tmp/aws-config", written: true }),
    });
    for (const prompt of fake.prompts) {
        assert.notEqual(prompt.type, "secret");
        assert.doesNotMatch(prompt.message ?? "", /enter (your |the )?(secret|access key)|secret access key:/i);
    }
});
