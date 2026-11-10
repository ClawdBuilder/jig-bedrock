// Tests resolve Pi's host packages from the Pi installed as a development dependency (test/support/pi-host-dir.mjs), as Pi maps them for extensions at runtime.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// Node 26 deprecates module.register(); registerHooks takes the same resolve hook without the loader warning.
const hostHooks = await import("./host-hooks.mjs");
registerHooks({ resolve: hostHooks.resolveSync });

// Every test process is cut off from the user's real credentials and settings before any test runs, whatever the test
// file does: the password store, AWS, gpg, Pi's agent folder, the home folder (where the SSO token cache and the catalog
// cache live) and the Windows side of WSL. A program that would reach a real system fails, first on the PATH; a test that
// needs one puts its own fake before it.
// Every temporary folder a test makes is under the real path of the system's: on macOS TMPDIR is /var/folders/..., and /var is a
// link to /private/var. The catalog refuses a cache whose path has a link in it (src/catalog.ts), so with the linked path every
// test that reads a cache would find none. Setting TMPDIR here changes what os.tmpdir() answers for the whole test process.
process.env.TMPDIR = realpathSync(tmpdir());
const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-isolated-"));
const bin = path.join(dir, "bin");
mkdirSync(bin);
for (const program of ["aws"]) {
    const file = path.join(bin, program);
    writeFileSync(file, `#!/bin/sh\necho '${program} is not available in tests' >&2\nexit 1\n`);
    chmodSync(file, 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.env.HOME = path.join(dir, "home");
mkdirSync(process.env.HOME);
process.env.PASSWORD_STORE_DIR = path.join(dir, "empty-store");
process.env.GNUPGHOME = path.join(dir, "gnupg");
process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
process.env.AWS_CONFIG_FILE = path.join(dir, "aws-config");
process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, "aws-credentials");
delete process.env.AWS_PROFILE;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
// No test believes it runs under WSL, reaches for the Windows interop socket or opens a browser, whatever machine it runs on.
// A test about WSL passes its own environment and its own fakes.
for (const name of ["WSL_INTEROP", "WSL_DISTRO_NAME", "BROWSER", "DISPLAY", "WAYLAND_DISPLAY"])
    delete process.env[name];
