// The Dependabot file must validate against the committed SchemaStore snapshot, not only look right.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(join(root, "test", "dependabot-schema.json"), "utf8"));
const config = parse(readFileSync(join(root, ".github", "dependabot.yml"), "utf8"));

test("dependabot.yml validates against the SchemaStore v2 snapshot", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(config);
    assert.ok(ok, JSON.stringify(validate.errors, null, 2));
    assert.equal(config.version, 2);
    assert.ok(Array.isArray(config.updates) && config.updates.length >= 2);
});
