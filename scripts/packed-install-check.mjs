// The package as a user gets it: pack this folder, install the tarball into a stock Pi the way `pi install` installs an
// npm package, start Pi, and prove the extension loaded and the published files are the ones a user needs.
//
//   node scripts/packed-install-check.mjs [--pi <path to the pi binary>] [--keep]
//
// How the install is real. `pi install <folder-or-tarball>` treats the argument as a local package and never installs its
// `dependencies`, and `pi install npm:/path/x.tgz` stores the path as the package name and loads nothing. Neither is what a
// user does. A user runs `pi install npm:@clawdbuilder/jig-bedrock@<version>`, which makes Pi run `npm install` into
// `<agent folder>/npm` and then load the package from there. This script runs exactly that command. Only the registry
// differs: a small server on 127.0.0.1 answers for this one package name with the tarball just packed, and passes every other
// name (the AWS SDK, for one) through to the public registry, so dependencies are installed for real. npm is pointed at the
// server with `npm_config_registry`; Pi's settings, install folder and loading are untouched.
//
// "Loads" is proven through Pi's rpc mode: Pi lists the extension's commands (`get_commands`), and `/bedrock` is answered
// by the extension with a notice. Pi's stderr must hold no extension error.
//
// Safe to run anywhere: it gives Pi a temporary HOME and agent folder, removes every AWS_*, PI_* and JIG_* variable, sets
// BROWSER=true, never calls AWS, and deletes its temporary folder (also on Ctrl-C). It never touches the real ~/.pi.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Where every package other than this one comes from. */
const UPSTREAM = "https://registry.npmjs.org";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const RPC_TIMEOUT_MS = 90_000;

/** Entries that must be in the installed package, and top-level folders that must not be. */
const REQUIRED = ["package.json", "index.ts", "src", "CHANGELOG.md", "README.md", "LICENSE", "docs"];
const FORBIDDEN = ["test", "scripts", ".github"];

const failures = [];
const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failures.push(message);
    return ok;
};

/** The environment Pi and npm run in: nothing of the caller's AWS, Pi or Jig setup, and a browser that does nothing. */
export function cleanEnvironment(base, home, agentDir, registry) {
    const env = {};
    for (const [name, value] of Object.entries(base)) {
        if (/^(AWS|PI|JIG)_/i.test(name) || /^AI_AGENT$/.test(name)) continue;
        // npm run sets npm_config_* for its own run; only the registry matters here and is set below.
        if (/^npm_(config|package|lifecycle|command|node|execpath)/i.test(name)) continue;
        env[name] = value;
    }
    delete env.NO_COLOR;
    env.TERM = "xterm-256color";
    env.LANG = "C.UTF-8";
    env.LC_ALL = "C.UTF-8";
    return {
        ...env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDir,
        BROWSER: "true",
        npm_config_registry: registry,
        // A project or user .npmrc of the machine must not change where this install goes.
        NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
        NPM_CONFIG_GLOBALCONFIG: path.join(home, ".npmrc-global"),
        npm_config_update_notifier: "false",
    };
}

/** `npm pack` into `folder`: the tarball's path and the digests npm needs to accept it. */
function pack(folder) {
    const result = spawnSync("npm", ["pack", "--json", "--pack-destination", folder], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
    });
    if (result.status !== 0) throw new Error("npm pack failed");
    const parsed = JSON.parse(result.stdout);
    // npm 10 and 11 print an array; npm 12 prints an object keyed by package name.
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const file = path.join(folder, entry.filename);
    const bytes = readFileSync(file);
    return {
        file,
        bytes,
        files: entry.files.map((f) => f.path),
        shasum: createHash("sha1").update(bytes).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
}

/** A registry on 127.0.0.1: this package from the tarball, everything else from the public registry. */
function startRegistry(manifest, tarball) {
    const tarballName = `${manifest.name.split("/").pop()}-${manifest.version}.tgz`;
    const server = createServer(async (request, response) => {
        const url = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (url === `/${manifest.name}`) {
            const version = {
                ...manifest,
                dist: { tarball: `${origin}/-/${tarballName}`, integrity: tarball.integrity, shasum: tarball.shasum },
            };
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    name: manifest.name,
                    "dist-tags": { latest: manifest.version },
                    versions: { [manifest.version]: version },
                }),
            );
            return;
        }
        if (url === `/-/${tarballName}`) {
            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": tarball.bytes.length,
            });
            response.end(tarball.bytes);
            return;
        }
        try {
            const upstream = await fetch(`${UPSTREAM}${request.url}`, {
                headers: { accept: request.headers.accept ?? "*/*" },
            });
            const body = Buffer.from(await upstream.arrayBuffer());
            response.writeHead(upstream.status, {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
            });
            response.end(body);
        } catch (error) {
            response.writeHead(502);
            response.end(String(error));
        }
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })),
    );
}

/**
 * Runs a program to the end without blocking this process: the registry server lives in it, and Pi's npm needs answers while
 * Pi runs. Standard input is closed (a stock Pi can wait on an open one).
 */
function run(command, args, { cwd, env, timeoutMs }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error}` });
        });
        child.on("close", (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stdout, stderr });
        });
    });
}

/** Pi's binary from this repository's own install: the Pi the tests run against, never a global one. */
function repoPi() {
    const bin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
    if (!existsSync(bin)) throw new Error(`no Pi at ${bin}; run npm ci first, or pass --pi <path>`);
    return bin;
}

/** Everything under `folder`, as paths relative to it. */
function entriesOf(folder) {
    const found = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            found.push(path.relative(folder, full).split(path.sep).join("/"));
            if (statSync(full).isDirectory()) walk(full);
        }
    };
    walk(folder);
    return found;
}

/** Runs Pi in rpc mode, sends the commands, and returns what came back. Resolves when every request has its response. */
function rpc(pi, env, cwd, requests) {
    return new Promise((resolve, reject) => {
        const child = spawn(pi, ["--mode", "rpc"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        let buffered = "";
        const lines = [];
        const answered = new Set();
        let sent = 0;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
                new Error(
                    `Pi rpc did not answer in ${RPC_TIMEOUT_MS / 1000} s. Heard: ${JSON.stringify(lines).slice(0, 2000)}\nstderr: ${stderr}`,
                ),
            );
        }, RPC_TIMEOUT_MS);
        const sendNext = () => {
            const next = requests[sent];
            if (next === undefined) return;
            sent += 1;
            child.stdin.write(`${JSON.stringify(next)}\n`);
        };
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.stdout.on("data", (chunk) => {
            buffered += chunk;
            for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
                const text = buffered.slice(0, end).trim();
                buffered = buffered.slice(end + 1);
                if (text === "") continue;
                let message;
                try {
                    message = JSON.parse(text);
                } catch {
                    lines.push({ unparsed: text });
                    continue;
                }
                lines.push(message);
                if (message.type === "response" && message.id !== undefined) {
                    answered.add(message.id);
                    // One request at a time, so a notice is attributed to the prompt that caused it.
                    if (answered.size === requests.length) {
                        // Pi writes the notice before the prompt's response; give stdout a moment, then close.
                        setTimeout(() => child.stdin.end(), 500);
                    } else sendNext();
                }
            }
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ lines, stderr, code });
        });
        sendNext();
    });
}

async function main() {
    const args = process.argv.slice(2);
    const keep = args.includes("--keep");
    const piArg = args.indexOf("--pi");
    const pi = piArg === -1 ? repoPi() : path.resolve(args[piArg + 1] ?? "");
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const spec = `${manifest.name}@${manifest.version}`;

    const work = mkdtempSync(path.join(tmpdir(), "jig-bedrock-packed-"));
    const home = path.join(work, "home");
    const agentDir = path.join(work, "agent");
    const project = path.join(work, "project");
    const packs = path.join(work, "pack");
    for (const dir of [home, agentDir, project, packs]) mkdirSync(dir);
    let registry;
    const cleanup = () => {
        registry?.server.close();
        if (keep) console.log(`kept ${work}`);
        else rmSync(work, { recursive: true, force: true });
    };
    process.on("SIGINT", () => {
        cleanup();
        process.exit(130);
    });
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(143);
    });

    try {
        console.log(`Pi binary: ${pi}`);
        const piVersion = await run(pi, ["--version"], {
            cwd: project,
            env: cleanEnvironment(process.env, home, agentDir, "http://127.0.0.1:1/"),
            timeoutMs: 60_000,
        });
        console.log(`Pi version: ${(piVersion.stdout || piVersion.stderr).trim()}`);
        const tarball = pack(packs);
        console.log(`packed ${path.basename(tarball.file)}: ${tarball.files.length} files`);
        check(tarball.files.length > 0, "npm pack lists files");

        registry = await startRegistry(manifest, tarball);
        const env = cleanEnvironment(process.env, home, agentDir, registry.url);

        // 1. The install a user runs.
        console.log(`\n$ pi install npm:${spec}   (registry ${registry.url}, agent folder ${agentDir})`);
        const install = await run(pi, ["install", `npm:${spec}`], { cwd: project, env, timeoutMs: INSTALL_TIMEOUT_MS });
        console.log(`${install.stdout}${install.stderr}`.trim());
        check(
            install.status === 0,
            `pi install exits 0 (exit ${install.status}${install.signal ? `, ${install.signal}` : ""})`,
        );

        const settings = existsSync(path.join(agentDir, "settings.json"))
            ? JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"))
            : {};
        const configured = (settings.packages ?? []).map((entry) => (typeof entry === "string" ? entry : entry.source));
        check(
            configured.includes(`npm:${spec}`),
            `Pi's settings name npm:${spec} (found ${JSON.stringify(configured)})`,
        );

        // 2. The installed files.
        const installed = path.join(agentDir, "npm", "node_modules", ...manifest.name.split("/"));
        check(
            existsSync(path.join(installed, "package.json")),
            `the package is installed at <agent folder>/npm/node_modules/${manifest.name}`,
        );
        const entries = existsSync(installed) ? entriesOf(installed) : [];
        for (const name of REQUIRED) check(entries.includes(name), `installed package has ${name}`);
        for (const name of FORBIDDEN)
            check(
                !entries.some((entry) => entry === name || entry.startsWith(`${name}/`)),
                `installed package has no ${name}/`,
            );
        const packedSet = new Set(tarball.files);
        const extra = entries.filter(
            (entry) =>
                !statSync(path.join(installed, entry)).isDirectory() &&
                !packedSet.has(entry) &&
                !entry.startsWith("node_modules/"),
        );
        check(extra.length === 0, `installed package holds only packed files (extra: ${JSON.stringify(extra)})`);

        // 3. The dependencies, next to the package, at the version package.json pins.
        for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
            const file = path.join(agentDir, "npm", "node_modules", ...name.split("/"), "package.json");
            const got = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : undefined;
            check(got === range, `${name} is installed next to the package at ${range} (found ${got})`);
            let resolved;
            try {
                resolved = createRequire(path.join(installed, "package.json")).resolve(`${name}/package.json`);
            } catch {}
            check(
                resolved?.startsWith(path.join(agentDir, "npm")) === true,
                `${name} resolves from the installed package`,
            );
        }
        for (const name of Object.keys(manifest.peerDependencies ?? {})) {
            check(
                !existsSync(path.join(agentDir, "npm", "node_modules", ...name.split("/"))),
                `${name} is not installed: Pi supplies it`,
            );
        }

        // 4. Pi starts and the extension is there.
        const result = await rpc(pi, env, project, [
            { id: "commands", type: "get_commands" },
            { id: "bedrock", type: "prompt", message: "/bedrock" },
            { id: "doctor", type: "prompt", message: "/bedrock doctor offline" },
            { id: "settings", type: "prompt", message: "/bedrock settings" },
        ]);
        const response = result.lines.find((m) => m.type === "response" && m.id === "commands");
        const commands = response?.data?.commands ?? [];
        const names = commands
            .filter((c) => c.source === "extension")
            .map((c) => c.name)
            .sort();
        console.log(`\nextension commands: ${names.join(", ")}`);
        for (const name of ["bedrock", "bedrock-refresh"]) {
            const found = commands.find((c) => c.name === name);
            check(found?.source === "extension", `Pi lists /${name} as an extension command`);
            check(
                typeof found?.sourceInfo?.path === "string" &&
                    path.resolve(found.sourceInfo.path).startsWith(path.resolve(installed)),
                `/${name} comes from the installed package (${found?.sourceInfo?.path})`,
            );
        }
        // Only what Pi said after the command list, so a notice Pi shows at start-up is not taken for the answer to /bedrock.
        const afterList = result.lines.slice(result.lines.indexOf(response) + 1);
        const notices = afterList.filter((m) => m.type === "extension_ui_request" && m.method === "notify");
        console.log(`/bedrock notices: ${JSON.stringify(notices.map((n) => n.message))}`);
        check(
            notices.some((n) => typeof n.message === "string" && /bedrock/i.test(n.message)),
            "/bedrock is answered by the extension with a notice that names Bedrock",
        );
        const reply = result.lines.find((m) => m.type === "response" && m.id === "bedrock");
        check(
            reply?.success === true && reply?.data?.disposition === "handled",
            `Pi says an extension command handled /bedrock (${JSON.stringify(reply)})`,
        );
        const normalize = (text) =>
            text
                .replaceAll(agentDir, "<agent>")
                .replace(/Node \d+\.\d+\.\d+/g, "Node <node>")
                .replace(/AWS CLI \d+\.\d+\.\d+/g, "AWS CLI <aws>");
        const screens = notices.map((notice) => normalize(String(notice.message ?? "")));
        const doctorScreen = screens.find((text) => text.startsWith("Bedrock doctor"));
        console.log(`doctor screen:\n${doctorScreen ?? "MISSING"}`);
        check(
            doctorScreen ===
                [
                    "Bedrock doctor",
                    "✓ Node <node>",
                    "✓ AWS CLI <aws>",
                    "✓ Settings: <agent>/bedrock.json",
                    "✗ AWS profile: none chosen; run /login",
                    "– AWS not checked: offline",
                    "– Models: not checked",
                    "– Selected model: none chosen",
                    "– Spend command: not set",
                    "1 problem.",
                    "Next: /login, choose Amazon Bedrock (jig-bedrock)",
                ].join("\n"),
            "the whole /bedrock doctor offline screen",
        );
        const settingsScreen = screens.find((text) => text.startsWith("Bedrock settings"));
        console.log(`settings screen:\n${settingsScreen ?? "MISSING"}`);
        check(
            settingsScreen ===
                [
                    "Bedrock settings · <agent>/bedrock.json",
                    "– regions: us-east-1 (default)",
                    "– ssoLoginCommand: aws sso login --profile {profile} (default)",
                    "– signInAtStart: false (default)",
                    "– api: messages (default)",
                    "– debug: false (default)",
                    "– tagKey: not set",
                    "– tagValue: not set",
                    "– activeTagKey: not set",
                    "– activeTagValue: not set",
                    "– profiles: not set",
                    "– profile: not set",
                    "– spendCommand: not set",
                    "– monthlyBudgetUsd: not set",
                    "– browser: not set",
                    "– converseModels: not set",
                    "– messagesModels: not set",
                ].join("\n"),
            "the whole /bedrock settings screen",
        );
        check(result.code === 0, `Pi exits 0 when its input closes (exit ${result.code})`);
        console.log(`Pi stderr: ${JSON.stringify(result.stderr.trim())}`);
        const loadErrors = [
            ...result.stderr.split("\n"),
            ...result.lines.filter((m) => m.type === "extension_error").map((m) => JSON.stringify(m)),
        ].filter((line) => /extension|jig-bedrock|cannot find|failed to load|error/i.test(line));
        check(loadErrors.length === 0, `no extension error on stderr or in rpc events (${JSON.stringify(loadErrors)})`);
    } finally {
        cleanup();
    }
    console.log(
        failures.length === 0
            ? "\nPASS: the packed package installs into a stock Pi and loads"
            : `\nFAIL: ${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
