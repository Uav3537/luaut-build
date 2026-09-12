/**
 * Lowering a type library brings with it.
 *
 * The compiler lowers luaut itself — `import`, `export`, `const`, optional
 * chains, the things the language means on its own. Everything a *library*
 * gives a value it must also say how to run: `names:filter(f)` is a call to a
 * function because `@luaut/lua` declares the method and ships the Luau behind
 * it, not because the compiler has heard of `filter`.
 *
 * A library names its module in package.json:
 *
 *     "luaut": { "types": "index.d.luaut", "lowering": "lowering.mjs" }
 *
 * and the module's default export is a `LoweringPlugin`. The compiler asks
 * each plugin, the last library loaded first, and takes the first answer.
 */
import { pathToFileURL } from "node:url"
import type { Type } from "luaut-parser"

export interface LoweringPlugin {
    /** Luau the plugin needs in the output, by a key it chooses. Each is a
     *  file's worth of source with `__NAME__` standing for the local the
     *  compiler gives it, and is emitted once, only if `use` asked for it:
     *
     *      local __NAME__ = {}
     *      function __NAME__.filter(t, test) ... end
     */
    readonly runtime?: Readonly<Record<string, string>>

    /** What `receiver:method(...)` becomes. `undefined` leaves it a plain
     *  Luau method call, which is what a value that answers to the method
     *  itself wants (`text:upper()`). */
    methodCall?(call: MethodCall): MethodLowering | undefined
}

export interface MethodCall {
    /** The name written after `:`. */
    readonly method: string
    /** The receiver's luaut type, as the analyzer worked it out — `undefined`
     *  when nothing typed it, where a plugin should decline. */
    readonly receiver: Type | undefined
    /** How many arguments were written. */
    readonly argumentCount: number
    /** The local name the output gives one of `runtime`'s entries, emitting
     *  it if this is the first call that needed it. */
    use(runtime: string): string
}

export interface MethodLowering {
    /** What to call instead: a name, or a `table.member` path. Usually built
     *  from `use(...)`. */
    readonly callee: string
    /** Pass the receiver as the first argument. Default: yes. */
    readonly passReceiver?: boolean
}

export interface LoadedLowering {
    readonly plugin: LoweringPlugin
    /** The package it came from, for reporting. */
    readonly from: string
}

export interface LoweringProblem {
    readonly file: string
    readonly message: string
}

/** Load what the project's type libraries lower. A module that will not load,
 *  or exports the wrong shape, is reported and skipped: the rest of the build
 *  is still worth having. */
export async function loadLowerings(
    modules: readonly { file: string; from: string }[],
): Promise<{ lowerings: LoadedLowering[]; problems: LoweringProblem[] }> {
    const lowerings: LoadedLowering[] = []
    const problems: LoweringProblem[] = []
    for (const module of modules) {
        try {
            const loaded = (await import(pathToFileURL(module.file).href)) as { default?: unknown }
            const plugin = loaded.default
            if (!plugin || typeof plugin !== "object") {
                problems.push({
                    file: module.file,
                    message: `'${module.from}' lowering module has no default export`,
                })
                continue
            }
            lowerings.push({ plugin: plugin as LoweringPlugin, from: module.from })
        } catch (error) {
            problems.push({
                file: module.file,
                message: `'${module.from}' lowering module failed to load: ${(error as Error).message}`,
            })
        }
    }
    return { lowerings, problems }
}
