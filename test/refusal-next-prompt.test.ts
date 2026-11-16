import assert from "node:assert/strict";
import test from "node:test";
import { refusalEvents, startRefusalProvider } from "./support/refusal-provider.ts";

test("a refusal keeps the next prompt in the editor and says why it was not sent", async (t) => {
    const s = await startRefusalProvider(t);
    const events = await refusalEvents(s.provider, s.model);
    assert.match(events[0]?.error?.errorMessage ?? "", /AWS refused claude-opus-5/);
    const input = s.hooks.get("input") ?? [];
    assert.equal(input.length, 1);
    const result = await input[0]?.({ text: "hello there", source: "interactive" }, s.ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(s.editor(), "hello there");
    assert.match(
        s.notices.join("\n"),
        /claude-opus-5 was refused by AWS for your role and is hidden\. Choose another model with \/model; your message is still in the editor\./,
    );
});
