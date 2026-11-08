/**
 * A subagent child is a short-lived Pi the parent started: the subagents extension sets PI_SUBAGENT_ID in it. PI_SUBAGENT_CHILD=1
 * is the older name, still accepted. Children skip display work and background AWS and usage program calls: nobody reads a footer there
 * and the parent already keeps the catalog and the usage figures fresh.
 */
export const isSubagentChild = (env: NodeJS.ProcessEnv = process.env): boolean =>
    !!env.PI_SUBAGENT_ID?.trim() || env.PI_SUBAGENT_CHILD === "1";
