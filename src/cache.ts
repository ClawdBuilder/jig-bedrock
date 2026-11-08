import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export function atomicCache(file: string, value: unknown): void {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 1_048_576) throw new Error("Cache too large");
    for (let p = dirname(file); dirname(p) !== p; p = dirname(p)) {
        try {
            if (lstatSync(p).isSymbolicLink()) throw new Error("Unsafe cache directory");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
        renameSync(temp, file);
    } finally {
        rmSync(temp, { force: true });
    }
}
