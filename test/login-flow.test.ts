// The guided /login flow: each way of answering AWS, verification, discovery choices, and the rule that no prompt ever
// asks for a secret. The AWS CLI owns credentials; the returned credential holds only AWS_PROFILE (or nothing for chain).
import assert from "node:assert/strict";
import test from "node:test";
import { type LoginFlowOptions, runLoginFlow } from "../src/login-flow.ts";
import type { DiscoverySettings, SaveDiscoveryResult } from "../src/settings-write.ts";

interface Prompt {
    type: string;
    message?: string;
}

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
                prompts.push({ type: prompt.type, message: prompt.message });
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
          : prompt.message === "Which Bedrock profiles should be listed?"
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
        prompt.type === "text"
            ? ""
            : prompt.message?.includes("How do you sign in to AWS?")
              ? "keys"
              : prompt.message === "Which Bedrock profiles should be listed?"
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
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /aws configure --profile my-profile/);
});

test("a role profile is explained, then listed again and verified", async () => {
    const fake = interaction((prompt) =>
        prompt.type === "text"
            ? ""
            : prompt.message?.includes("How do you sign in to AWS?")
              ? "role"
              : prompt.message === "Which Bedrock profiles should be listed?"
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
    assert.match(fake.notices.map((notice) => notice.message).join("\n"), /role_arn and source_profile/);
});

test("an SSO profile signs in first, then verifies, and only SSO profiles are listed", async () => {
    const fake = interaction((prompt) =>
        prompt.message?.includes("How do you sign in to AWS?")
            ? "sso"
            : prompt.message === "Which Bedrock profiles should be listed?"
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
        (prompt) => prompt.message === "Which SSO profile do you want to sign in to?",
    );
    assert.ok(optionsShown);
});

test("a typed non-SSO profile is refused before any sign-in", async () => {
    let ssoAttempts = 0;
    const fake = interaction((prompt) => {
        if (prompt.message?.includes("How do you sign in to AWS?")) return "sso";
        if (prompt.message === "Which SSO profile do you want to sign in to?") {
            ssoAttempts++;
            return ssoAttempts === 1 ? "type" : "profile:demo-sso";
        }
        if (prompt.message === "AWS profile name") return "keys";
        if (prompt.message === "Which Bedrock profiles should be listed?") return "system";
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
            : prompt.message === "Which Bedrock profiles should be listed?"
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
        if (prompt.message === "Which Bedrock profiles should be listed?") return "system";
        return "profile:keys";
    });
    const credential = await runLoginFlow(fake.value as never, options());
    assert.deepEqual(credential.env, { AWS_PROFILE: "keys" });
    assert.match(
        fake.prompts.map((prompt) => prompt.message ?? "").join("\n"),
        /not supported by this package/,
        "the reason stays on screen in the next method prompt",
    );
});

test("a failed check says so and asks again", async () => {
    let attempt = 0;
    const fake = interaction((prompt) => {
        if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
        if (prompt.message === "Which Bedrock profiles should be listed?") return "system";
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
            if (prompt.message === "Which Bedrock profiles should be listed?") return mode;
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

test("a Jig section that shadows a saved key is named", async () => {
    const fake = interaction(profileAnswer("keys"));
    const result: SaveDiscoveryResult = { file: "/tmp/bedrock.json", written: true, shadowed: ["regions"] };
    await runLoginFlow(fake.value as never, { ...options(), saveDiscovery: () => result });
    assert.match(
        fake.notices.map((notice) => notice.message).join("\n"),
        /jig\.json's bedrock section sets regions and wins/,
    );
});

test("no prompt ever asks for a secret and no credential carries a key", async () => {
    for (const method of ["existing", "sso", "keys", "role", "chain"]) {
        const fake = interaction((prompt) => {
            if (prompt.message?.includes("How do you sign in to AWS?")) return method;
            if (prompt.message === "Which Bedrock profiles should be listed?") return "system";
            return method === "sso" ? "profile:demo-sso" : "profile:keys";
        });
        const credential = await runLoginFlow(fake.value as never, options());
        for (const prompt of fake.prompts) {
            assert.ok(prompt.type === "select" || prompt.type === "text", `${method}: prompt type ${prompt.type}`);
            assert.doesNotMatch(prompt.message ?? "", /secret|access key id|secret access key/i);
        }
        assert.equal("key" in credential, false);
        assert.doesNotMatch(JSON.stringify(credential), /secret|access.?key/i);
    }
});
