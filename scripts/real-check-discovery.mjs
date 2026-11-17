#!/usr/bin/env node
// Real Bedrock discovery check: runs the package's own discovery against a real AWS profile and prints the counts.
// It makes the package's own signed HTTPS calls with that AWS profile's credentials (no `aws` program runs) and writes
// its cache to a temp directory. Run it yourself; it is not shipped and is never run by CI.
//
//   node scripts/real-check-discovery.mjs --profile <aws-profile> [--regions us-east-1] [--tag my-team]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCallerIdentity, getInferenceProfile, getResources, listInferenceProfiles } from "../src/aws-api.ts";
import { createAwsDiscovery, problemSummary } from "../src/aws-discovery.ts";

const args = process.argv.slice(2);
const options = { regions: "us-east-1", tag: undefined, profile: undefined, keep: false, help: false };
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile") options.profile = args[++i];
    else if (args[i] === "--regions") options.regions = args[++i];
    else if (args[i] === "--tag") options.tag = args[++i];
    else if (args[i] === "--keep") options.keep = true;
    else if (args[i] === "--help" || args[i] === "-h") options.help = true;
}
if (options.help || !options.profile) {
    console.log(
        "usage: node scripts/real-check-discovery.mjs --profile <aws-profile> [--regions us-east-1] [--tag my-team] [--keep]",
    );
    console.log("");
    console.log("--tag runs tagged discovery; without it, AWS-defined Claude profiles are listed.");
    process.exit(options.help ? 0 : 2);
}

const redact = (text) => String(text).replace(/\b\d{12}\b/g, "<account>");
const dir = mkdtempSync(join(tmpdir(), "jig-bedrock-real-discovery-"));
const file = join(dir, "catalog.json");
const config = {
    profile: options.profile,
    regions: options.regions
        .split(",")
        .map((region) => region.trim())
        .filter(Boolean),
    ...(options.tag === undefined ? {} : { team: options.tag, tagKey: "Team", tagValue: options.tag }),
    ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
    signInAtStart: false,
};

let calls = 0;
let failedCalls = 0;
const byKind = { account: 0, "system listing": 0, "tag listing": 0, "profile read": 0 };
const started = Date.now();
/** One of the package's own AWS calls, counted and timed; a failure is printed with account ids hidden, then thrown again. */
const counted =
    (kind, call) =>
    async (...callArgs) => {
        const number = ++calls;
        byKind[kind]++;
        const at = Date.now();
        try {
            return await call(...callArgs);
        } catch (error) {
            failedCalls++;
            console.log(`call ${number} failed after ${Date.now() - at}ms (${kind}): ${redact(error).slice(0, 240)}`);
            throw error;
        }
    };
const api = {
    getCallerIdentity: counted("account", getCallerIdentity),
    getResources: counted("tag listing", getResources),
    listInferenceProfiles: counted("system listing", listInferenceProfiles),
    getInferenceProfile: counted("profile read", getInferenceProfile),
};

const source = createAwsDiscovery(config, file, Date.now, process.env, { api });
const status = await source.refresh(true);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const catalog = source.load();
console.log("");
console.log(`status: ${status}`);
console.log(`calls: ${calls} (${failedCalls} failed)`);
console.log(`seconds: ${seconds}`);
console.log(
    `calls by kind: account ${byKind.account}, system listing ${byKind["system listing"]}, tag listing ${byKind["tag listing"]}, profile read ${byKind["profile read"]}`,
);
console.log(`profiles: ${catalog?.profiles.length ?? 0}`);
console.log(`profile errors: ${catalog?.errors?.length ?? 0}`);
const summary = problemSummary(catalog?.errors ?? []);
if (summary) console.log(`summary: ${redact(summary)}`);
if (source.failure?.()) console.log(`failure: ${redact(source.failure())}`);
console.log(`cache: ${file}`);
if (!options.keep) rmSync(dir, { recursive: true, force: true });
else console.log("kept for inspection");
process.exit(status === "ok" ? 0 : 1);
