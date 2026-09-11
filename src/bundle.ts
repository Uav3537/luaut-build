/**
 * A luaut project -> one Luau file.
 *
 * Roblox's `require` takes an Instance, so a bundle cannot use it between its
 * own modules. Instead every module becomes a function in one table, loaded
 * by a `require` of the bundle's own:
 *
 *   local G
 *   G = {
 *       modules = {
 *           ["src/util"] = function(exports)
 *               exports.clamp = function(x) ... end
 *           end,
 *           ["src/main"] = function(exports)
 *               local util
 *               util = G.require("src/util")
 *               print(util.clamp(2))
 *           end,
 *       },
 *       records = {},
 *       require = function(name) ... end,
 *   }
 *   G.require("src/main")
 *
 * A module's record is created, with `loading = true`, before its function
 * runs. That is what makes a cycle behave like ES modules rather than loop
 * forever: when `a` imports `b` and `b` imports `a` back, `b` gets `a`'s
 * exports table as it stands — partly filled, but already holding `a`'s
 * hoisted functions — and every value `a` exports later shows up in it, since
 * modules read each other's exports live (see `lower.ts`).
 */
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import {
    parse, analyzeScopes, analyzeTypes, moduleExports, resolveModulePath, resolveTypeLibraries,
    ParseError, LexError,
    type ModuleExports, type Program, type ScopeAnalysis, type LuautConfig, type TypeAnalysis,
} from "luaut-parser"
import { parse as parseLuau, print, type Statement as LuauStatement, type TableExpression } from "luau-parser"
import { resolveConfig, type ConfigInput } from "./config.js"
import { lower } from "./lower.js"
import * as luau from "./luau.js"
import { Names } from "./names.js"

export interface BundleOptions {
    /** The file the bundle runs. */
    readonly entry: string
    /** A `luaut.config.json` path or contents. Default: the nearest config above the entry. */
    readonly config?: ConfigInput
    /** The project folder. Modules are named by their path from it, and an
     *  inline config's relative paths resolve from it. Default: the config
     *  file's folder, or else the entry's. */
    readonly root?: string
    /** Check types against the config's `types` too. Default: true. */
    readonly typeCheck?: boolean
}

export interface BundleDiagnostic {
    /** Absolute path of the file it is about. */
    readonly file: string
    readonly message: string
    readonly line: number
    readonly column: number
    /** `type` and `config` problems are reported without stopping the build;
     *  `syntax` and `module` problems leave no bundle. */
    readonly category: "syntax" | "module" | "type" | "config"
}

export interface BundleResult {
    /** The bundle, or `undefined` when a module could not be compiled. Type
     *  errors are reported but do not stop it. */
    readonly code?: string
    /** The bundled modules' names, entry first. */
    readonly modules: string[]
    readonly diagnostics: BundleDiagnostic[]
}

interface SourceModule {
    readonly file: string
    readonly name: string
    readonly program: Program
    readonly scopes: ScopeAnalysis
}

export function bundle(options: BundleOptions): BundleResult {
    const entry = resolve(options.entry)
    const diagnostics: BundleDiagnostic[] = []
    const inline = options.config !== undefined && typeof options.config !== "string"
    const { config, problems } = resolveConfig(options.config, entry, options.root ?? (inline ? dirname(entry) : process.cwd()))
    for (const p of problems) diagnostics.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const root = resolve(options.root ?? config?.directory ?? dirname(entry))
    const nameOf = (file: string): string => relative(root, file).replace(/\\/g, "/").replace(/\.luaut$/, "")

    // Every module the entry reaches through an import, types included.
    const sources = new Map<string, SourceModule>()
    const queue = [entry]
    while (queue.length) {
        const file = queue.shift()!
        if (sources.has(file)) continue
        const program = parseFile(file, diagnostics)
        if (!program) return { modules: [], diagnostics }
        sources.set(file, { file, name: nameOf(file), program, scopes: analyzeScopes(program) })
        for (const specifier of importedSpecifiers(program)) {
            const target = resolveModulePath(file, specifier, config)
            if (target && !target.endsWith(".d.luaut")) queue.push(target)
        }
    }

    // Types are needed either way: lowering reads them (`for x in list`).
    const analysis = analyzeModules([...sources.values()], config)
    if (options.typeCheck !== false) diagnostics.push(...analysis.diagnostics)

    // Lower each module the entry needs at runtime: an import only of types
    // requires nothing, and brings no module in.
    const names = Names.from(...[...sources.values()].map(s => s.program))
    const G = names.fresh("G")
    const requireExpression = luau.member(luau.identifier(G), "require")
    const modules = new Map<string, { name: string; statements: LuauStatement[]; exportsName: string; exports: boolean }>()
    const pending = [entry]
    while (pending.length) {
        const file = pending.shift()!
        if (modules.has(file)) continue
        const source = sources.get(file)!
        const lowered = lower(source.program, source.scopes, {
            names,
            types: analysis.types.get(file),
            module: {
                require: requireExpression,
                resolve: specifier => {
                    const target = resolveModulePath(file, specifier, config)
                    if (!target || target.endsWith(".d.luaut") || !sources.has(target)) return undefined
                    pending.push(target)
                    return sources.get(target)!.name
                },
            },
        })
        for (const d of lowered.diagnostics) diagnostics.push({ file, ...d, category: "module" })
        modules.set(file, {
            name: source.name,
            statements: lowered.statements,
            exportsName: lowered.exportsName,
            exports: source.program.body.statements.some(isExport),
        })
    }

    // The type checker reports a missing module too; say it once.
    const moduleProblems = new Set(diagnostics.filter(d => d.category === "module").map(d => `${d.file}:${d.line}:${d.column}:${d.message}`))
    const reported = diagnostics.filter(d => d.category !== "type" || !moduleProblems.has(`${d.file}:${d.line}:${d.column}:${d.message}`))
    diagnostics.length = 0
    diagnostics.push(...reported)

    const moduleNames = [...modules.values()].map(m => m.name)
    if (diagnostics.some(d => d.category === "syntax" || d.category === "module")) {
        return { modules: moduleNames, diagnostics }
    }

    const program = parseLuau(runtime(G))
    const assignment = program.body.statements[1]
    const modulesTable = assignment.type === "AssignmentStatement" && assignment.values[0].type === "TableExpression"
        ? (assignment.values[0].fields.find(f => f.type === "TableFieldNamed" && f.name.name === "modules") as { value: TableExpression } | undefined)?.value
        : undefined
    if (!modulesTable) throw new Error("luaut-build: the bundle runtime has no modules table")
    for (const module of modules.values()) {
        modulesTable.fields.push({
            type: "TableFieldComputed",
            key: luau.string(module.name),
            // Vararg, so a top-level `...` is still valid Luau.
            value: luau.functionExpression(luau.functionBody([module.exportsName], module.statements, true)),
        })
    }
    const start = luau.call(requireExpression, [luau.string(sources.get(entry)!.name)])
    program.body.statements.push(modules.get(entry)!.exports ? luau.returns([start]) : luau.callStatement(start))

    return { code: print(program) + "\n", modules: moduleNames, diagnostics }
}

/** The module table and its `require`, around the modules. */
function runtime(G: string): string {
    return `
local ${G}
${G} = {
    modules = {},
    records = {},
    require = function(name)
        local record = ${G}.records[name]
        if record == nil then
            record = { loading = true, exports = {} }
            ${G}.records[name] = record
            ${G}.modules[name](record.exports)
            record.loading = false
        end
        return record.exports
    end,
}
`
}

function parseFile(file: string, diagnostics: BundleDiagnostic[]): Program | undefined {
    let text: string
    try {
        text = readFileSync(file, "utf8")
    } catch {
        diagnostics.push({ file, message: "Cannot read file", line: 1, column: 1, category: "module" })
        return undefined
    }
    try {
        return parse(text)
    } catch (error) {
        if (error instanceof ParseError || error instanceof LexError) {
            const { line, column } = error as unknown as { line: number; column: number }
            diagnostics.push({ file, message: (error as Error).message, line, column, category: "syntax" })
            return undefined
        }
        throw error
    }
}

function importedSpecifiers(program: Program): string[] {
    return program.body.statements.flatMap(s =>
        s.type === "ImportStatement" || s.type === "ExportAllStatement" || (s.type === "ExportNamedStatement" && s.source)
            ? [(s as { source: { value: string } }).source.value]
            : [])
}

function isExport(statement: Program["body"]["statements"][number]): boolean {
    return statement.type === "ExportStatement" || statement.type === "ExportDefaultStatement" ||
        statement.type === "ExportNamedStatement" || statement.type === "ExportAllStatement"
}

/** Every module's types, and its type errors, against the config's type libraries. */
function analyzeModules(
    modules: SourceModule[],
    config: LuautConfig | undefined,
): { types: Map<string, TypeAnalysis>; diagnostics: BundleDiagnostic[] } {
    const out: BundleDiagnostic[] = []
    const analyses = new Map<string, TypeAnalysis>()
    const libraries = config ? resolveTypeLibraries(config) : { files: [], problems: [] }
    for (const p of libraries.problems) out.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })
    const libs = libraries.files.map(file => parse(readFileSync(file, "utf8")))
    const globals = libs.flatMap(lib => lib.body.statements.flatMap(s => (s.type === "DeclareStatement" ? [s.name] : [])))

    const byFile = new Map(modules.map(m => [m.file, m]))
    const exportsCache = new Map<string, ModuleExports>()
    const inProgress = new Set<string>()
    const resolverFor = (file: string) => (specifier: string): ModuleExports | undefined => {
        const target = resolveModulePath(file, specifier, config)
        if (!target) return undefined
        if (inProgress.has(target)) return { values: new Map(), types: new Map(), partial: true }
        const cached = exportsCache.get(target)
        if (cached) return cached
        let program = byFile.get(target)?.program
        if (!program) {
            try {
                program = parse(readFileSync(target, "utf8"))
            } catch {
                return undefined
            }
        }
        inProgress.add(target)
        try {
            const scopes = analyzeScopes(program, { builtinGlobals: globals })
            const types = analyzeTypes(program, scopes, { libs, resolveModule: resolverFor(target), diagnostics: false })
            const exports = moduleExports(program, scopes, types, resolverFor(target))
            exportsCache.set(target, exports)
            return exports
        } finally {
            inProgress.delete(target)
        }
    }

    for (const module of modules) {
        const scopes = analyzeScopes(module.program, { builtinGlobals: globals })
        const types = analyzeTypes(module.program, scopes, { libs, resolveModule: resolverFor(module.file) })
        analyses.set(module.file, types)
        for (const d of types.diagnostics) {
            const at = d.node as { line: { start: number }; column: { start: number } }
            out.push({ file: module.file, message: d.message, line: at.line.start, column: at.column.start, category: "type" })
        }
    }
    return { types: analyses, diagnostics: out }
}
