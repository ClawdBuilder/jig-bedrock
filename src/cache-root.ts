// Where this package's catalog cache lives: `jig-bedrock/catalog.json` under the user's cache root (`XDG_CACHE_HOME`, else
// `~/.cache`). The root is the user's own choice and may be a link (`~/.cache` on another disk, or the temporary folder under
// /var on macOS), so its real path is resolved here and used from then on. Below it, in the package's own folder, a link is
// still refused (src/cache.ts when writing, src/catalog.ts when reading).
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The user's cache root, as they named it: `XDG_CACHE_HOME` when it is an absolute path, else `~/.cache`. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
    const named = env.XDG_CACHE_HOME;
    return named?.startsWith("/") ? named : join(env.HOME || homedir(), ".cache");
}

/**
 * The cache root with every link in it followed. With `create`, a missing root is made first (private, as the package
 * makes its own folder). When the root cannot be resolved the name is returned as it is, and the guards below it decide.
 */
export function realCacheRoot(env: NodeJS.ProcessEnv = process.env, create = false): string {
    const root = cacheRoot(env);
    try {
        return realpathSync(root);
    } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") return root;
    }
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        return realpathSync(root);
    } catch {
        return root;
    }
}

/** The catalog cache file under the real cache root; `create` makes the root when it is missing (before a write). */
export function catalogFile(env: NodeJS.ProcessEnv = process.env, create = false): string {
    return join(realCacheRoot(env, create), "jig-bedrock", "catalog.json");
}
