// The guided `/login` flow for Amazon Bedrock (jig-bedrock): ask how the person signs in to AWS, verify the answer with
// `aws sts get-caller-identity`, then ask what discovery should list. jig-bedrock never asks for, sees or stores a secret;
// the AWS CLI owns the credentials, and the credential this flow returns holds only a profile name in AWS_PROFILE.
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { VerifyResult } from "./aws-profile.ts";
import { isSsoProfile } from "./aws-profile.ts";
import { profilePattern } from "./config.ts";
import type { ListProfiles } from "./profile.ts";
import type { DiscoverySettings, SaveDiscoveryResult } from "./settings-write.ts";
import { recoveryHint } from "./sso.ts";

export interface LoginFlowOptions {
    /** The long listing /login may wait for. */
    listProfiles: ListProfiles;
    /** A fresh listing after the person was told to create a profile in a terminal. */
    refreshProfiles?: () => Promise<string[] | undefined>;
    isSso?: (profile: string) => boolean;
    verify: (profile: string | undefined, signal: AbortSignal) => Promise<VerifyResult>;
    signIn?: (profile: string, signal: AbortSignal) => Promise<void>;
    saveDiscovery?: (settings: DiscoverySettings) => SaveDiscoveryResult;
    /** The configured regions, used as the default answer. */
    regions?: string[];
}

const methods = [
    { id: "existing", label: "An AWS profile that already works" },
    { id: "sso", label: "Sign in to an existing IAM Identity Center (SSO) profile" },
    { id: "keys", label: "Set up access keys with the AWS CLI" },
    { id: "role", label: "Use an IAM role profile" },
    { id: "chain", label: "Use the AWS credential chain (no profile)" },
    { id: "key", label: "Use a Bedrock API key with Pi's own provider" },
] as const;

type Method = (typeof methods)[number]["id"];

const profileCredential = (profile: string): ApiKeyCredential => ({ type: "api_key", env: { AWS_PROFILE: profile } });

/** A profile from the CLI's list, or a typed name; never a secret. */
async function askProfile(
    interaction: ProviderAuthInteraction,
    listed: string[] | undefined,
    message = "Which AWS profile should Bedrock use?",
): Promise<string> {
    interaction.signal.throwIfAborted();
    let name: string;
    if (listed !== undefined && listed.length > 0) {
        const answer = await interaction.prompt({
            type: "select",
            message,
            options: [
                ...listed.map((profile) => ({ id: `profile:${profile}`, label: profile })),
                { id: "type", label: "Type another profile name" },
            ],
        });
        interaction.signal.throwIfAborted();
        name =
            answer === "type"
                ? await interaction.prompt({ type: "text", message: "AWS profile name", placeholder: "my-profile" })
                : answer.replace(/^profile:/, "");
    } else {
        if (listed === undefined)
            interaction.notify({ type: "info", message: "Could not list your AWS profiles; type the name." });
        name = await interaction.prompt({
            type: "text",
            message: "AWS profile name (aws configure sso or aws configure makes one)",
            placeholder: "my-profile",
        });
    }
    interaction.signal.throwIfAborted();
    name = name.trim();
    if (!profilePattern.test(name)) throw new Error("That is not an AWS profile name.");
    if (listed !== undefined && !listed.includes(name))
        interaction.notify({ type: "info", message: `${name} is not in aws configure list-profiles yet.` });
    return name;
}

async function requiredText(
    interaction: ProviderAuthInteraction,
    message: string,
    placeholder: string,
): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const value = (await interaction.prompt({ type: "text", message, placeholder })).trim();
        interaction.signal.throwIfAborted();
        if (value !== "") return value;
        interaction.notify({ type: "info", message: "A value is required." });
    }
    throw new Error("No value entered.");
}

async function askDiscovery(interaction: ProviderAuthInteraction, options: LoginFlowOptions): Promise<void> {
    const mode = await interaction.prompt({
        type: "select",
        message: "Which Bedrock profiles should be listed?",
        options: [
            { id: "system", label: "All AWS-defined Claude inference profiles" },
            { id: "tag", label: "Profiles with a tag I name" },
            { id: "explicit", label: "A list of profile ARNs or ids" },
        ],
    });
    interaction.signal.throwIfAborted();
    const settings: DiscoverySettings = {
        mode: mode === "tag" || mode === "explicit" ? mode : "system",
        regions: options.regions ?? ["us-east-1"],
    };
    if (settings.mode === "tag") {
        settings.tagKey = await requiredText(interaction, "Tag key", "Team");
        settings.tagValue = await requiredText(interaction, "Tag value", "my-team");
    } else if (settings.mode === "explicit") {
        const text = await requiredText(
            interaction,
            "Profile ARNs or ids (comma separated)",
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile",
        );
        settings.profiles = text
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value !== "");
    }
    const current = settings.regions.join(", ");
    const regions = (
        await interaction.prompt({
            type: "text",
            message: "AWS regions for discovery (comma separated)",
            placeholder: current,
        })
    )
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
    interaction.signal.throwIfAborted();
    if (regions.length > 0) settings.regions = regions;
    const save = options.saveDiscovery?.(settings);
    if (save === undefined) return;
    if (!save.written)
        interaction.notify({ type: "info", message: `Bedrock settings were not saved: ${save.error ?? save.file}` });
    else if (save.shadowed.length > 0)
        interaction.notify({
            type: "info",
            message: `Saved discovery to ${save.file}, but jig.json's bedrock section sets ${save.shadowed.join(", ")} and wins.`,
        });
    else interaction.notify({ type: "info", message: `Saved discovery to ${save.file}.` });
}

/** Ask how to sign in, verify, ask discovery, and return the credential Pi stores. */
export async function runLoginFlow(
    interaction: ProviderAuthInteraction,
    options: LoginFlowOptions,
): Promise<ApiKeyCredential> {
    interaction.signal.throwIfAborted();
    interaction.notify({ type: "progress", message: "Looking up your AWS profiles…" });
    let listed = await options.listProfiles(interaction.signal);
    let note = "";
    for (let attempt = 0; attempt < 10; attempt++) {
        interaction.signal.throwIfAborted();
        const method = (await interaction.prompt({
            type: "select",
            message: note === "" ? "How do you sign in to AWS?" : `${note}\n\nHow do you sign in to AWS?`,
            options: methods,
        })) as Method;
        interaction.signal.throwIfAborted();
        note = "";
        if (method === "key") {
            // Keep the reason on screen: it becomes the next method prompt, instead of a status line a new prompt replaces.
            note =
                "Bedrock API keys are not supported by this package. Use Pi's own Amazon Bedrock provider, or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or an IAM Identity Center (SSO) profile.";
            continue;
        }
        if (method === "chain") {
            interaction.notify({ type: "progress", message: "Checking the AWS credential chain…" });
            const check = await options.verify(undefined, interaction.signal);
            if (!check.ok) {
                interaction.notify({ type: "info", message: check.message });
                continue;
            }
            await askDiscovery(interaction, options);
            return { type: "api_key" };
        }
        if (method === "keys" || method === "role") {
            // The instruction is the dialog: the person can switch to a terminal, and the list is fetched only after
            // they say the profile exists. A notify would vanish when the pick-list replaced it.
            const guidance =
                method === "keys"
                    ? "Run this in a terminal, then come back:\n\n  aws configure --profile my-profile\n\nIt asks for the access key ID and secret access key and writes them to ~/.aws/credentials; the region and output go to ~/.aws/config. jig-bedrock never asks for or stores them.\n\nWhen the profile exists, continue."
                    : "Add a profile to ~/.aws/config, then come back:\n\n  [profile my-profile]\n  role_arn = arn:aws:iam::123456789012:role/MyRole\n  source_profile = my-source-profile\n  region = us-east-1\n\nsource_profile must already exist. The AWS CLI obtains and caches the role's temporary credentials (and asks for an MFA code when mfa_serial is set); jig-bedrock never asks for it.\n\nWhen the profile exists, continue.";
            const ready = await interaction.prompt({
                type: "select",
                message: guidance,
                options: [
                    { id: "ready", label: "I have created it — list my profiles" },
                    { id: "back", label: "Back to the sign-in methods" },
                ],
            });
            interaction.signal.throwIfAborted();
            if (ready !== "ready") continue;
            interaction.notify({ type: "progress", message: "Looking up your AWS profiles…" });
            listed = await (options.refreshProfiles?.() ?? options.listProfiles(interaction.signal));
        } else if (method === "sso") {
            listed = await (options.refreshProfiles?.() ?? options.listProfiles(interaction.signal));
            const ssoListed =
                listed === undefined ? undefined : listed.filter((profile) => options.isSso?.(profile) ?? false);
            if (ssoListed !== undefined && ssoListed.length === 0) {
                interaction.notify({
                    type: "info",
                    message:
                        "No IAM Identity Center (SSO) profiles are configured. Run aws configure sso in a terminal, then try again.",
                });
                continue;
            }
            const name = await askProfile(interaction, ssoListed, "Which SSO profile do you want to sign in to?");
            if (!(options.isSso?.(name) ?? false)) {
                interaction.notify({
                    type: "info",
                    message: `${name} is not an IAM Identity Center (SSO) profile.`,
                });
                continue;
            }
            interaction.notify({
                type: "progress",
                message: `Signing in to ${name}; complete the browser sign-in.`,
            });
            try {
                await options.signIn?.(name, interaction.signal);
            } catch (error) {
                interaction.notify({ type: "info", message: recoveryHint(error) });
                continue;
            }
            interaction.notify({ type: "progress", message: `Checking ${name} with AWS…` });
            const check = await options.verify(name, interaction.signal);
            if (!check.ok) {
                interaction.notify({ type: "info", message: check.message });
                continue;
            }
            await askDiscovery(interaction, options);
            return profileCredential(name);
        }
        const name = await askProfile(interaction, listed);
        interaction.notify({ type: "progress", message: `Checking ${name} with AWS…` });
        const check = await options.verify(name, interaction.signal);
        if (!check.ok) {
            interaction.notify({ type: "info", message: check.message });
            continue;
        }
        await askDiscovery(interaction, options);
        return profileCredential(name);
    }
    throw new Error("Too many sign-in attempts. Run /login again.");
}
