/**
 * Which `luaut.config.json` a build uses.
 */
import { resolve } from "node:path"
import { findConfig, loadConfig, nodeHost, type ConfigProblem, type LuautConfig } from "luaut-parser"

/** What `luaut.config.json` holds. */
export interface LuautConfigJson {
    /** Type libraries to check against: `["roblox"]` loads `@luaut/roblox`. */
    types?: string[]
    /** Import path aliases, as in tsconfig: `{ "@shared/*": ["src/shared/*"] }`. */
    paths?: Record<string, string[]>
    /** Where `paths` targets resolve from. Default: the config's folder. */
    baseUrl?: string
    /** A Rojo sourcemap, or `null`. */
    sourceMap?: string | null
}

/** A config file's path, or the config itself. Relative paths — to a config
 *  file, and inside an inline config — resolve from `cwd`. */
export type ConfigInput = string | LuautConfigJson

export interface ResolvedConfig {
    readonly config?: LuautConfig
    readonly problems: readonly ConfigProblem[]
}

/** The config for a build of `entry`: the one given, or else the nearest
 *  `luaut.config.json` above the entry. */
export function resolveConfig(input: ConfigInput | undefined, entry: string, cwd = process.cwd()): ResolvedConfig {
    if (input === undefined) return findConfig(entry)
    if (typeof input === "string") return loadConfig(resolve(cwd, input))
    const path = resolve(cwd, "luaut.config.json")
    const text = JSON.stringify(input, null, 2)
    return loadConfig(path, { readFile: file => (file === path ? text : nodeHost.readFile(file)) })
}
