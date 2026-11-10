// The guided `/login` flow for Amazon Bedrock (jig-bedrock): ask how the person signs in to AWS, verify the answer with
// `aws sts get-caller-identity`, then ask what discovery should list. jig-bedrock never asks for, sees or stores a secret;
// the AWS CLI owns the credentials, and the credential this flow returns holds only a profile name in AWS_PROFILE.
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { type ConfigSection, type ConfigWriteResult, renderSections } from "./aws-config-write.ts";
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
    /** Where the AWS config is, for the confirmation text. */
    configFile?: string;
    /** Append the confirmed sections; without it the create-a-profile methods are unavailable. */
    writeConfig?: (sections: ConfigSection[]) => ConfigWriteResult;
}

const methods = [
    // The common case first; the other rows are the choices that really differ.
    { id: "existing", label: "An AWS profile that already works" },
    { id: "sso-new", label: "Create an IAM Identity Center (SSO) profile" },
    { id: "role-new", label: "Create an IAM role profile" },
    { id: "chain", label: "Use the AWS credential chain (no profile)" },
    { id: "key", label: "Use a Bedrock API key with Pi's own provider" },
] as const;

type Method = (typeof methods)[number]["id"] | "keys" | "role" | "sso";

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
                { id: "type", label: "Type another AWS profile name" },
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
    if (!profilePattern.test(name)) {
        interaction.notify({ type: "info", message: "That is not an AWS profile name; choose or type another." });
        return askProfile(interaction, listed, message);
    }
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

const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const roleNamePattern = /^[\w+=,.@-]{1,64}$/;
const roleArnPattern = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

function say(interaction: ProviderAuthInteraction, message: string): void {
    interaction.notify({ type: "info", message });
}

async function askName(interaction: ProviderAuthInteraction, message: string, placeholder = "my-profile") {
    const name = (await interaction.prompt({ type: "text", message, placeholder })).trim();
    interaction.signal.throwIfAborted();
    if (!profilePattern.test(name)) {
        say(interaction, "An AWS profile name uses letters, numbers and _-./@; choose another.");
        return undefined;
    }
    return name;
}

async function confirmConfig(
    interaction: ProviderAuthInteraction,
    options: LoginFlowOptions,
    sections: ConfigSection[],
): Promise<boolean> {
    const answer = await interaction.prompt({
        type: "select",
        message: `Add these lines to ${options.configFile ?? "~/.aws/config"}?\n\n${renderSections(sections)}\n\nA backup of the current file is kept.`,
        options: [
            { id: "write", label: "Write these lines" },
            { id: "back", label: "Back to the sign-in methods" },
        ],
    });
    interaction.signal.throwIfAborted();
    if (answer !== "write") return false;
    const result = options.writeConfig?.(sections);
    if (result === undefined) {
        say(interaction, "This build cannot write the AWS config; choose another sign-in method.");
        return false;
    }
    if (!result.written) {
        say(interaction, `The AWS config was not written: ${result.error ?? result.file}`);
        return false;
    }
    say(interaction, `Wrote ${result.file}${result.backup === undefined ? "" : `; backup at ${result.backup}`}.`);
    return true;
}

async function askDiscovery(interaction: ProviderAuthInteraction, options: LoginFlowOptions): Promise<void> {
    const mode = await interaction.prompt({
        type: "select",
        message: "Which inference profiles should Bedrock list?",
        options: [
            { id: "system", label: "All AWS-defined Claude inference profiles" },
            { id: "tag", label: "Inference profiles with a tag I name" },
            { id: "explicit", label: "Inference profiles I list by ARN or id" },
        ],
    });
    interaction.signal.throwIfAborted();
    const settings: DiscoverySettings = {
        mode: mode === "tag" || mode === "explicit" ? mode : "system",
        regions: options.regions ?? ["us-east-1"],
    };
    if (settings.mode === "tag") {
        settings.tagKey = await requiredText(interaction, "Tag key", "CostCenter");
        settings.tagValue = await requiredText(interaction, "Tag value", "my-value");
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
            note = "Use Pi's built-in Amazon Bedrock provider for an API key.";
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
            const name = await askProfile(interaction, ssoListed, "Which AWS SSO profile do you want to sign in to?");
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
        if (method === "sso-new") {
            const profile = await askName(interaction, "New AWS SSO profile name");
            if (profile === undefined) continue;
            const typedSession = (
                await interaction.prompt({ type: "text", message: "SSO session name", placeholder: "my-sso" })
            ).trim();
            interaction.signal.throwIfAborted();
            const session = typedSession === "" ? profile : typedSession;
            if (!profilePattern.test(session)) {
                say(interaction, "An SSO session name uses letters, numbers and _-./@; choose another.");
                continue;
            }
            const startUrl = (
                await interaction.prompt({
                    type: "text",
                    message: "SSO start URL",
                    placeholder: "https://my-sso-portal.awsapps.com/start",
                })
            ).trim();
            interaction.signal.throwIfAborted();
            if (!/^https:\/\/\S+$/.test(startUrl)) {
                say(interaction, "The SSO start URL must start with https://.");
                continue;
            }
            const ssoRegion =
                (
                    await interaction.prompt({
                        type: "text",
                        message: "SSO region",
                        placeholder: options.regions?.[0] ?? "us-east-1",
                    })
                ).trim() ||
                (options.regions?.[0] ?? "us-east-1");
            interaction.signal.throwIfAborted();
            if (!regionPattern.test(ssoRegion)) {
                say(interaction, "Use an AWS region such as us-east-1.");
                continue;
            }
            const accountId = (
                await interaction.prompt({
                    type: "text",
                    message: "SSO account ID",
                    placeholder: "123456789012",
                })
            ).trim();
            interaction.signal.throwIfAborted();
            if (!/^\d{12}$/.test(accountId)) {
                say(interaction, "Use the 12-digit AWS account ID.");
                continue;
            }
            const ssoRole = (
                await interaction.prompt({ type: "text", message: "SSO role name", placeholder: "ReadOnly" })
            ).trim();
            interaction.signal.throwIfAborted();
            if (!roleNamePattern.test(ssoRole)) {
                say(interaction, "Use the IAM role name (letters, numbers and +=,.@-).");
                continue;
            }
            const region = (
                await interaction.prompt({ type: "text", message: "AWS profile region", placeholder: ssoRegion })
            ).trim();
            interaction.signal.throwIfAborted();
            const profileRegion = region === "" ? ssoRegion : region;
            if (!regionPattern.test(profileRegion)) {
                say(interaction, "Use an AWS region such as us-east-1.");
                continue;
            }
            const sections: ConfigSection[] = [
                {
                    header: `profile ${profile}`,
                    entries: [
                        ["sso_session", session],
                        ["sso_account_id", accountId],
                        ["sso_role_name", ssoRole],
                        ["region", profileRegion],
                    ],
                },
                {
                    header: `sso-session ${session}`,
                    entries: [
                        ["sso_region", ssoRegion],
                        ["sso_start_url", startUrl],
                    ],
                },
            ];
            if (!(await confirmConfig(interaction, options, sections))) continue;
            interaction.notify({
                type: "progress",
                message: `Signing in to ${profile}; complete the browser sign-in.`,
            });
            try {
                await options.signIn?.(profile, interaction.signal);
            } catch (error) {
                interaction.notify({ type: "info", message: recoveryHint(error) });
                continue;
            }
            interaction.notify({ type: "progress", message: `Checking ${profile} with AWS…` });
            const check = await options.verify(profile, interaction.signal);
            if (!check.ok) {
                say(interaction, check.message);
                continue;
            }
            await askDiscovery(interaction, options);
            return profileCredential(profile);
        }
        if (method === "role-new") {
            const profile = await askName(interaction, "New AWS role profile name");
            if (profile === undefined) continue;
            const roleArn = (
                await interaction.prompt({
                    type: "text",
                    message: "Role ARN",
                    placeholder: "arn:aws:iam::123456789012:role/MyRole",
                })
            ).trim();
            interaction.signal.throwIfAborted();
            if (!roleArnPattern.test(roleArn)) {
                say(interaction, "Use a role ARN such as arn:aws:iam::123456789012:role/MyRole.");
                continue;
            }
            let source: string;
            if (listed !== undefined && listed.length > 0) {
                const answer = await interaction.prompt({
                    type: "select",
                    message: "Which AWS profile is the source (source_profile)?",
                    options: [
                        ...listed.map((name) => ({ id: `profile:${name}`, label: name })),
                        { id: "type", label: "Type another AWS profile name" },
                    ],
                });
                interaction.signal.throwIfAborted();
                source =
                    answer === "type"
                        ? (
                              await interaction.prompt({
                                  type: "text",
                                  message: "Source AWS profile name",
                                  placeholder: "my-source-profile",
                              })
                          ).trim()
                        : answer.replace(/^profile:/, "");
            } else {
                source = (
                    await interaction.prompt({
                        type: "text",
                        message: "Source AWS profile name",
                        placeholder: "my-source-profile",
                    })
                ).trim();
            }
            interaction.signal.throwIfAborted();
            if (!profilePattern.test(source) || (listed !== undefined && !listed.includes(source))) {
                say(interaction, `${source} is not in aws configure list-profiles; source_profile must already exist.`);
                continue;
            }
            const region =
                (
                    await interaction.prompt({
                        type: "text",
                        message: "Role region",
                        placeholder: options.regions?.[0] ?? "us-east-1",
                    })
                ).trim() ||
                (options.regions?.[0] ?? "us-east-1");
            interaction.signal.throwIfAborted();
            if (!regionPattern.test(region)) {
                say(interaction, "Use an AWS region such as us-east-1.");
                continue;
            }
            const mfaSerial = (
                await interaction.prompt({
                    type: "text",
                    message: "MFA serial number (optional; leave empty for none)",
                    placeholder: "arn:aws:iam::123456789012:mfa/my-user",
                })
            ).trim();
            interaction.signal.throwIfAborted();
            const externalId = (
                await interaction.prompt({
                    type: "text",
                    message: "External ID (optional; leave empty for none)",
                    placeholder: "",
                })
            ).trim();
            interaction.signal.throwIfAborted();
            const entries: Array<[string, string]> = [
                ["role_arn", roleArn],
                ["source_profile", source],
                ["region", region],
            ];
            if (mfaSerial !== "") entries.push(["mfa_serial", mfaSerial]);
            if (externalId !== "") entries.push(["external_id", externalId]);
            const sections: ConfigSection[] = [{ header: `profile ${profile}`, entries }];
            if (!(await confirmConfig(interaction, options, sections))) continue;
            interaction.notify({ type: "progress", message: `Checking ${profile} with AWS…` });
            const check = await options.verify(profile, interaction.signal);
            if (!check.ok) {
                say(interaction, check.message);
                continue;
            }
            await askDiscovery(interaction, options);
            return profileCredential(profile);
        }
        const name = await askProfile(interaction, listed);
        interaction.notify({ type: "progress", message: `Checking ${name} with AWS…` });
        let check = await options.verify(name, interaction.signal);
        if (!check.ok && (options.isSso?.(name) ?? false)) {
            interaction.notify({ type: "info", message: `Sign-in expired for ${name}; opening the browser sign-in.` });
            try {
                await options.signIn?.(name, interaction.signal);
                interaction.notify({ type: "progress", message: `Checking ${name} with AWS…` });
                check = await options.verify(name, interaction.signal);
            } catch (error) {
                interaction.notify({
                    type: "info",
                    message: `Sign-in expired for ${name}: ${error instanceof Error ? error.message : String(error)}`,
                });
                continue;
            }
        }
        if (!check.ok) {
            interaction.notify({ type: "info", message: check.message });
            continue;
        }
        await askDiscovery(interaction, options);
        return profileCredential(name);
    }
    throw new Error("Too many sign-in attempts. Run /login again.");
}
