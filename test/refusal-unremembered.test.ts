import assert from "node:assert/strict";
import test from "node:test";
import { refusalEvents, startRefusalProvider } from "./support/refusal-provider.ts";

test("a refusal that cannot be remembered still reads plainly", {
    skip: process.platform === "win32" ? "the cache folder permissions are a POSIX test" : false,
}, async (t) => {
    const s = await startRefusalProvider(t, { unwritable: true });
    let events: any[] = [];
    await assert.doesNotReject(async () => {
        events = await refusalEvents(s.provider, s.model);
    });
    const message = events.find((event) => event.type === "error")?.error?.errorMessage ?? "";
    assert.match(message, /AWS refused claude-opus-5/);
    assert.match(
        message,
        /Could not remember this refusal in ~\/cache\/jig-bedrock: (EACCES|EPERM|EROFS|permission denied)/,
    );
});
