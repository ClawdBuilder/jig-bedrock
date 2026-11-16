import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBedrockSelectionGuard } from "../src/catalog.ts";

test("a saved model restored after a late refresh is selected and announced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-restore-"));
    try {
        writeFileSync(
            join(dir, "settings.json"),
            JSON.stringify({ defaultProvider: "jig-bedrock", defaultModel: "claude-sonnet-5-5" }),
        );
        const model = { id: "claude-sonnet-5-5", arn: "arn:test", aliases: [] };
        const models: any[] = [];
        const notices: string[] = [];
        const pi = {
            on() {},
            setModel: async (selected: any) => {
                ctx.model = selected;
                return true;
            },
        };
        const ctx: any = {
            model: undefined,
            mode: "rpc",
            hasUI: true,
            sessionManager: { getBranch: () => [] },
            modelRegistry: { find: (_provider: string, id: string) => models.find((entry) => entry.id === id) },
            ui: { notify: (text: string) => notices.push(text), setEditorText() {} },
        };
        const guard = registerBedrockSelectionGuard(pi as never, models as never, { agentDir: dir });
        guard.blockUntilChoice();
        models.push({ id: "claude-sonnet-5-5-global", arn: "arn:global", aliases: [] }, model);
        await guard.restoreSaved(ctx);
        assert.equal(ctx.model, model);
        assert.equal(guard.unresolved(), false);
        assert.match(notices.join("\n"), /restored claude-sonnet-5-5/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the unresolved warning says the models are still arriving, not unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-restore-"));
    try {
        writeFileSync(
            join(dir, "settings.json"),
            JSON.stringify({ defaultProvider: "jig-bedrock", defaultModel: "claude-sonnet-5-5" }),
        );
        const notices: string[] = [];
        const pi = { on() {}, setModel: async () => true };
        const guard = registerBedrockSelectionGuard(pi as never, [], { agentDir: dir });
        guard.blockUntilChoice();
        await guard.restoreSaved({
            model: undefined,
            mode: "rpc",
            hasUI: true,
            sessionManager: { getBranch: () => [] },
            modelRegistry: { find: () => undefined },
            ui: { notify: (text: string) => notices.push(text), setEditorText() {} },
        } as never);
        assert.match(notices.join("\n"), /models are still arriving/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
