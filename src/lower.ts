/**
 * luaut AST -> Luau AST.
 *
 * Everything luaut adds over Luau is rewritten into plain Luau here; the
 * result is an ordinary luau-parser tree, printed by luau-parser's printer.
 *
 *   const { a, b } = value          local a, b = value.a, value.b
 *   const [x, y] = list             local x, y = list[1], list[2]
 *   { name: "n", count }            { name = "n", count = count }
 *   [...xs, 1]                      concat(xs, { 1 })
 *   `${a} any`                      ("%s any"):format(tostring(a))
 *   function f(n = 1) ... end       function f(n) if n == nil then n = 1 end ... end
 *   x as T / x satisfies T          x
 *
 * Types have no runtime meaning, so every annotation, alias and `declare` is
 * dropped: the output is untyped Luau.
 *
 * ## Modules
 *
 * In a bundle each file becomes a function that fills in its `exports` table
 * (see `bundle.ts`), and modules behave the way ES modules do:
 *
 *   - **Live bindings.** An exported binding lives on `exports` itself, so
 *     every read and write of it goes through `exports.name`. An imported name
 *     is read through the imported module's table (`util.clamp`), never
 *     copied — a value the other module sets later is still seen.
 *   - **Hoisting.** Every top-level name is declared before any code runs, and
 *     every top-level function is defined then too, ahead of the imports. In a
 *     cycle — `a` imports `b`, which imports `a` while `a` is still loading —
 *     `b` receives `a`'s partly filled table, and can already call its
 *     functions.
 */
import type * as T from "luaut-parser"
import type { Binding, BindingId, ScopeAnalysis, Type, TypeAnalysis } from "luaut-parser"
import type * as L from "luau-parser"
import * as luau from "./luau.js"
import { Names } from "./names.js"

/** What lowering a file as a module of a bundle needs. */
export interface ModuleContext {
    /** The bundle's name for this module. */
    readonly name: string
    /** The bundle's name for the module `specifier` imports, or `undefined`
     *  when there is no such module (reported). */
    resolve(specifier: string): string | undefined
    /** The bundle's `require`: an expression that, called with a module's
     *  name, returns its exports table. */
    readonly require: L.Expression
}

export interface LowerOptions {
    /** Lower the file as a module of a bundle. Without it, `import` and
     *  `export` are errors. */
    readonly module?: ModuleContext
    /** Names already taken beyond the file's own — a bundle's. */
    readonly names?: Names
    /** The file's types. They decide what `for x in t` means: over a table
     *  it yields the values, which in Luau needs a key variable before `x`. */
    readonly types?: TypeAnalysis
}

export interface LowerDiagnostic {
    readonly message: string
    readonly line: number
    readonly column: number
}

export interface LowerResult {
    readonly statements: L.Statement[]
    /** In a module: the parameter the statements fill in with the exports. */
    readonly exportsName: string
    /** In a module: what the bundle's `require` needs to know about it. */
    readonly module: ModuleInfo
    readonly diagnostics: LowerDiagnostic[]
}

/** How a module's exports behave at runtime, beyond what its code assigns. */
export interface ModuleInfo {
    /** Names the module itself exports. Reading one before the module has
     *  initialized it is an error, as in ES modules. */
    readonly names: string[]
    /** Names re-exported from another module — `export { x as y } from` —
     *  read from that module on every access, so they stay live.
     *  `imported` is `undefined` for the whole module (`import * as M; export { M }`). */
    readonly links: { name: string; module: string; imported?: string }[]
    /** `export * from` modules, consulted live for any other name. */
    readonly stars: string[]
    /** Whether the module exports anything. */
    exports: boolean
}

export function lower(program: T.Program, scopes: ScopeAnalysis, options: LowerOptions = {}): LowerResult {
    return new Lowerer(program, scopes, options).run()
}

/** A runtime helper the output needs, emitted once at the top of the file. */
type Helper = "assign" | "concat"

type Mode = "declare" | "assign"

class Lowerer {
    private readonly names: Names
    private readonly diagnostics: LowerDiagnostic[] = []
    private readonly helpers = new Map<Helper, string>()
    /** The binding each declaration node creates. */
    private readonly bindingByDeclaration = new Map<object, Binding>()
    /** luaut names that are Luau keywords, and what they are called instead. */
    private readonly renamed = new Map<string, string>()
    /** Bindings read through something else: an export through `exports.x`,
     *  an import through its module's table. */
    private readonly rewrites = new Map<BindingId, () => L.Expression>()
    private readonly exportsName: string
    /** Globals generated code calls, renamed where the source shadows them. */
    private readonly builtins = new Map<string, string>()

    constructor(
        private readonly source: T.Program,
        private readonly scopes: ScopeAnalysis,
        private readonly options: LowerOptions,
    ) {
        this.names = options.names ? options.names.fork() : Names.from(source)
        this.exportsName = this.names.fresh("exports")
        for (const binding of scopes.bindings.values()) {
            if (binding.declarationNode) this.bindingByDeclaration.set(binding.declarationNode, binding)
        }
    }

    run(): LowerResult {
        const body = this.options.module
            ? this.module(this.options.module)
            : this.source.body.statements.flatMap(s => this.statement(s))
        const helpers = this.helperDefinitions()
        // Captured before any of the file's code runs — before its own `table`.
        const captured = [...this.builtins].map(([global, local]) => luau.local([local], [luau.identifier(global)]))
        return {
            statements: [...captured, ...helpers, ...body],
            exportsName: this.exportsName,
            module: this.info,
            diagnostics: this.diagnostics,
        }
    }

    private report(node: T.BaseNode, message: string): void {
        this.diagnostics.push({ message, line: node.line.start, column: node.column.start })
    }

    // --------------------------------------------------------
    // Names
    // --------------------------------------------------------

    /** A luaut name as Luau can write it: `local` is a keyword there. */
    private name(name: string): string {
        if (!luau.LUAU_KEYWORDS.has(name)) return name
        let renamed = this.renamed.get(name)
        if (!renamed) {
            renamed = this.names.fresh(`${name}_`)
            this.renamed.set(name, renamed)
        }
        return renamed
    }

    private bindingIdOf(node: object): BindingId | undefined {
        return this.scopes.bindingOf.get(node as T.Identifier) ?? this.bindingByDeclaration.get(node)?.id
    }

    /** How Luau refers to a name: its own local, or what it was rewritten to. */
    private reference(node: T.Identifier | T.IdentifierPattern): L.Expression {
        const id = this.bindingIdOf(node)
        const rewrite = id === undefined ? undefined : this.rewrites.get(id)
        return rewrite ? rewrite() : luau.identifier(this.name(node.name))
    }

    /** A global the generated code calls — `pairs`, `table`, ... — under a name
     *  the source cannot have shadowed. */
    private builtin(global: string): L.Identifier {
        let local = this.builtins.get(global)
        if (!local) {
            const shadowed = [...this.scopes.bindings.values()].some(b => b.name === global && b.kind !== "global")
            if (!shadowed) return luau.identifier(global)
            local = this.names.fresh(`luaut_${global}`)
            this.builtins.set(global, local)
        }
        return luau.identifier(local)
    }

    private helper(kind: Helper): L.Identifier {
        let name = this.helpers.get(kind)
        if (!name) {
            name = this.names.fresh(kind === "assign" ? "luaut_assign" : "luaut_concat")
            this.helpers.set(kind, name)
        }
        return luau.identifier(name)
    }

    private helperDefinitions(): L.Statement[] {
        const out: L.Statement[] = []
        const assign = this.helpers.get("assign")
        if (assign) {
            // assign(target, ...sources): copy each source's keys into target, in order.
            out.push(luau.localFunction(assign, luau.functionBody(["target"], [
                luau.numericFor("i", luau.number(1), selectCount(this.builtin("select")), [
                    luau.local(["source"], [luau.call(this.builtin("select"), [luau.identifier("i"), vararg()])]),
                    luau.ifThen(luau.binary("~=", luau.identifier("source"), luau.nil()), [
                        luau.genericFor(["key", "value"], [luau.call(this.builtin("pairs"), [luau.identifier("source")])], [
                            luau.assign([luau.index(luau.identifier("target"), luau.identifier("key"))], [luau.identifier("value")]),
                        ]),
                    ]),
                ]),
                luau.returns([luau.identifier("target")]),
            ], true)))
        }
        const concat = this.helpers.get("concat")
        if (concat) {
            // concat(...parts): one array holding every part's elements, in order.
            out.push(luau.localFunction(concat, luau.functionBody([], [
                luau.local(["result"], [luau.table([])]),
                luau.numericFor("i", luau.number(1), selectCount(this.builtin("select")), [
                    luau.local(["part"], [luau.call(this.builtin("select"), [luau.identifier("i"), vararg()])]),
                    luau.callStatement(luau.call(luau.member(this.builtin("table"), "move"), [
                        luau.identifier("part"), luau.number(1), luau.unary("#", luau.identifier("part")),
                        luau.binary("+", luau.unary("#", luau.identifier("result")), luau.number(1)),
                        luau.identifier("result"),
                    ])),
                ]),
                luau.returns([luau.identifier("result")]),
            ], true)))
        }
        return out
    }

    // --------------------------------------------------------
    // Modules
    // --------------------------------------------------------

    private readonly info: ModuleInfo = { names: [], links: [], stars: [], exports: false }

    /** The module body, in the order an ES module runs:
     *
     *    local a, b, util          -- every top-level name, declared first
     *    function exports.f() ...  -- every top-level function, hoisted
     *    util = require("util")    -- the imports
     *    ...                       -- the rest, in source order */
    private module(context: ModuleContext): L.Statement[] {
        const statements = this.source.body.statements
        const exportsTable = (): L.Identifier => luau.identifier(this.exportsName)
        const { names, links, stars } = this.info
        const locals: string[] = []
        const requires: L.Statement[] = []
        /** Required modules, one local each however many statements import them. */
        const moduleLocals = new Map<string, string>()
        /** Where each imported binding comes from, for re-exporting it live. */
        const importedFrom = new Map<BindingId, { module: string; imported?: string }>()

        const resolve = (source: T.StringLiteral): string | undefined => {
            const key = context.resolve(source.value)
            if (key === undefined) this.report(source, `Cannot find module '${source.value}'`)
            return key
        }
        /** A local holding the module's exports, required where imports run. */
        const moduleLocal = (key: string): string => {
            let local = moduleLocals.get(key)
            if (!local) {
                local = this.names.fresh(moduleName(key))
                moduleLocals.set(key, local)
                locals.push(local)
                requires.push(luau.assign([luau.identifier(local)], [luau.call(context.require, [luau.string(key)])]))
            }
            return local
        }
        /** Loaded for its place in the order only: its exports are linked, not read here. */
        const load = (key: string): void => {
            if (!moduleLocals.has(key)) requires.push(luau.callStatement(luau.call(context.require, [luau.string(key)])))
        }

        const exportBinding = (node: object | undefined, exported: string): void => {
            const binding = node && this.bindingByDeclaration.get(node)
            if (!binding) return
            const existing = this.rewrites.get(binding.id)
            if (existing) {
                // Exported again under another name: the same value, read live.
                const first = memberChain(existing())
                links.push({ name: exported, module: context.name, imported: first?.[first.length - 1] })
                return
            }
            names.push(exported)
            this.rewrites.set(binding.id, () => luau.member(exportsTable(), exported))
        }

        // Imports first: an export may name an imported binding.
        for (const statement of statements) {
            // `import type` exists for the type checker alone: no module is
            // required for it, whatever it names.
            if (statement.type !== "ImportStatement" || statement.isTypeOnly) continue
            const specifiers = [
                ...(statement.defaultImport ? [{ local: statement.defaultImport, imported: "default" as string | undefined }] : []),
                ...(statement.namespaceImport ? [{ local: statement.namespaceImport, imported: undefined }] : []),
                ...statement.specifiers.map(s => ({ local: s.local, imported: s.imported.name as string | undefined })),
            ]
            // A binding read nowhere — say, a type — needs no module.
            const used = specifiers.filter(s => (this.bindingByDeclaration.get(s.local)?.references.length ?? 0) > 0)
            if (!used.length) continue
            const key = resolve(statement.source)
            if (key === undefined) continue
            const local = moduleLocal(key)
            for (const s of used) {
                const binding = this.bindingByDeclaration.get(s.local)!
                importedFrom.set(binding.id, { module: key, imported: s.imported })
                const imported = s.imported
                this.rewrites.set(binding.id, imported === undefined
                    ? () => luau.identifier(local)
                    : () => luau.member(luau.identifier(local), imported))
            }
        }

        // Then what the module exports.
        for (const statement of statements) {
            switch (statement.type) {
                case "ExportStatement": {
                    const declaration = statement.declaration
                    if (declaration.type === "FunctionDeclaration") exportBinding(declaration.name, declaration.name.name)
                    else for (const pattern of declaration.names.flatMap(identifierPatterns)) exportBinding(pattern, pattern.name)
                    break
                }
                case "ExportDefaultStatement":
                    names.push("default")
                    break
                case "ExportNamedStatement": {
                    if (statement.source) {
                        const key = resolve(statement.source)
                        if (key === undefined) break
                        load(key)
                        for (const s of statement.specifiers) links.push({ name: s.exported.name, module: key, imported: s.local.name })
                        break
                    }
                    for (const s of statement.specifiers) {
                        const declaration = topLevelDeclaration(statements, s.local.name)
                        const binding = declaration && this.bindingByDeclaration.get(declaration.node)
                        const from = binding && importedFrom.get(binding.id)
                        if (from) links.push({ name: s.exported.name, ...from })
                        else if (declaration?.type === "Declaration") exportBinding(declaration.node, s.exported.name)
                        // Otherwise it names a type: nothing exists at runtime.
                    }
                    break
                }
                case "ExportAllStatement": {
                    const key = resolve(statement.source)
                    if (key === undefined) break
                    load(key)
                    stars.push(key)
                    break
                }
            }
        }
        this.info.exports = names.length > 0 || links.length > 0 || stars.length > 0

        // Every other top-level name is a local of the module function,
        // declared up front so hoisted functions can see it.
        for (const statement of statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type === "VariableDeclaration") {
                for (const pattern of declaration.names.flatMap(identifierPatterns)) {
                    if (!this.isRewritten(pattern)) locals.push(this.name(pattern.name))
                }
            } else if (declaration.type === "FunctionDeclaration" && !this.isRewritten(declaration.name)) {
                locals.push(this.name(declaration.name.name))
            }
        }

        const hoisted: L.Statement[] = []
        const body: L.Statement[] = []
        for (const statement of statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type === "FunctionDeclaration") {
                // `function exports.f()` / `function f()`: assigns the export, or
                // the local declared above, and keeps attributes such as `@native`.
                hoisted.push(this.functionStatement(this.reference(declaration.name), declaration, declaration.func, false))
                continue
            }
            switch (declaration.type) {
                case "VariableDeclaration":
                    body.push(...this.variableDeclaration(declaration, "assign"))
                    break
                case "ExportDefaultStatement":
                    body.push(luau.assign([luau.member(exportsTable(), "default")], [this.expression(declaration.declaration)]))
                    break
                case "ReturnStatement":
                    // An early `return` stops the module; a value has nowhere to go.
                    if (declaration.arguments.length) this.report(declaration, "A module cannot return a value; export it instead")
                    body.push(luau.returns([]))
                    break
                case "ImportStatement":
                case "ExportNamedStatement":
                case "ExportAllStatement":
                    break
                default:
                    body.push(...this.statement(declaration))
            }
        }

        const declarations: L.Statement[] = []
        for (let i = 0; i < locals.length; i += 100) declarations.push(luau.local(locals.slice(i, i + 100), []))
        return [...declarations, ...hoisted, ...requires, ...body]
    }

    /** Is `expression` a table iterated directly — not an iterator function
     *  such as `pairs(t)` or `string.gmatch(s, p)`? Known from its type. */
    private iteratesTable(expression: T.Expression): boolean {
        const types = this.options.types
        const type = types?.typeOf.get(expression)
        if (!types || !type) return false
        const seen = new Set<Type>()
        const table = (t: Type): boolean => {
            if (seen.has(t)) return false
            seen.add(t)
            switch (t.kind) {
                case "array":
                case "tuple":
                    return true
                case "object":
                    return !t.class
                case "union":
                    return t.types.every(m => (m.kind === "primitive" && m.name === "nil") || table(m))
                case "intersection":
                    return t.types.some(table)
                case "genericRef": {
                    const alias = types.aliases.get(t.name)
                    return alias !== undefined && table(alias)
                }
                default:
                    return false
            }
        }
        return table(type)
    }

    private isRewritten(node: object): boolean {
        const binding = this.bindingByDeclaration.get(node)
        return binding !== undefined && this.rewrites.has(binding.id)
    }

    // --------------------------------------------------------
    // Statements
    // --------------------------------------------------------

    private block(block: T.Block, prelude: L.Statement[] = []): L.Block {
        return luau.block([...prelude, ...block.statements.flatMap(s => this.statement(s))])
    }

    private statement(node: T.Statement): L.Statement[] {
        switch (node.type) {
            // Types, and what exists only for them.
            case "TypeAliasStatement":
            case "ExportTypeAliasStatement":
            case "DeclareStatement":
            case "DeclareClassStatement":
            case "ErrorStatement":
                return []

            case "VariableDeclaration":
                return this.variableDeclaration(node, "declare")

            case "FunctionDeclaration":
                return [{ ...luau.localFunction(this.name(node.name.name), this.functionBody(node.func)), attributes: node.attributes }]

            case "FunctionDeclarationStatement":
                return [this.functionDeclarationStatement(node)]

            case "AssignmentStatement":
                return this.assignment(node)

            case "CompoundAssignmentStatement":
                return [{
                    type: "CompoundAssignmentStatement",
                    operator: node.operator,
                    target: this.expression(node.target),
                    value: this.expression(node.value),
                    ...spanOf(node),
                }]

            case "CallStatement": {
                const expression = this.expression(node.expression)
                if (expression.type !== "CallExpression" && expression.type !== "MethodCallExpression") {
                    this.report(node, "A statement must be a call")
                    return []
                }
                return [luau.callStatement(expression)]
            }

            case "DoStatement":
                return [{ type: "DoStatement", body: this.block(node.body), ...spanOf(node) }]

            case "WhileStatement":
                return [{ type: "WhileStatement", condition: this.expression(node.condition), body: this.block(node.body), ...spanOf(node) }]

            case "RepeatStatement":
                return [{ type: "RepeatStatement", body: this.block(node.body), condition: this.expression(node.condition), ...spanOf(node) }]

            case "IfStatement":
                return [{
                    type: "IfStatement",
                    clauses: node.clauses.map(c => ({
                        type: "IfClause", condition: this.expression(c.condition), body: this.block(c.body), ...spanOf(c),
                    })),
                    alternate: node.alternate && this.block(node.alternate),
                    ...spanOf(node),
                }]

            case "NumericForStatement":
                return [{
                    type: "NumericForStatement",
                    variable: { type: "TypedIdentifier", name: this.name(node.variable.name), ...spanOf(node.variable) },
                    start: this.expression(node.start),
                    end: this.expression(node.end),
                    step: node.step && this.expression(node.step),
                    body: this.block(node.body),
                    ...spanOf(node),
                }]

            case "GenericForStatement": {
                // `for _, { a, b } in pairs(t)`: each pattern becomes a loop
                // variable that the body destructures first.
                const prelude: L.Statement[] = []
                const variables = node.variables.map(target => {
                    if (target.type === "IdentifierPattern") return this.name(target.name)
                    const temp = this.names.fresh("item")
                    prelude.push(...this.destructure(target, luau.identifier(temp), "declare"))
                    return temp
                })
                // `for x in list` yields the values in luaut, as its types say;
                // Luau yields the keys first.
                if (variables.length === 1 && node.iterators.length === 1 && this.iteratesTable(node.iterators[0])) {
                    variables.unshift(this.names.fresh("_"))
                }
                return [luau.genericFor(variables, node.iterators.map(e => this.expression(e)), this.block(node.body, prelude).statements)]
            }

            case "ReturnStatement":
                return [luau.returns(node.arguments.map(e => this.expression(e)))]

            case "BreakStatement":
                return [{ type: "BreakStatement", ...spanOf(node) }]

            case "ContinueStatement":
                return [{ type: "ContinueStatement", ...spanOf(node) }]

            case "ImportStatement":
                // Types only: erased like every other type.
                if (node.isTypeOnly) return []
                this.report(node, this.options.module
                    ? "Imports and exports belong at the top level of a module"
                    : "Imports and exports need a bundle: build the project with luaut-build")
                return []
            case "ExportStatement":
            case "ExportDefaultStatement":
            case "ExportNamedStatement":
            case "ExportAllStatement":
                this.report(node, this.options.module
                    ? "Imports and exports belong at the top level of a module"
                    : "Imports and exports need a bundle: build the project with luaut-build")
                return []
        }
    }

    private functionDeclarationStatement(node: T.FunctionDeclarationStatement): L.FunctionDeclarationStatement {
        // `function util.helper()` where `util` is rewritten to `exports.util`:
        // the base becomes `exports`, and the rest of the path follows.
        const statement = this.functionStatement(this.reference(node.target.base), node, node.func, node.isMethod, node.target.path.map(p => p.name))
        if (!node.target.method) return statement
        return { ...statement, target: { ...statement.target, method: luau.identifier(node.target.method.name) } }
    }

    /** `function a.b.c()`, for a target written as an expression. */
    private functionStatement(
        target: L.Expression,
        node: T.BaseNode & { attributes?: string[] },
        func: T.FunctionBody,
        isMethod: boolean,
        path: string[] = [],
    ): L.FunctionDeclarationStatement {
        const chain = memberChain(target)
        if (!chain) this.report(node, "This function name cannot be written in Luau")
        const [root, ...prefix] = chain ?? ["_"]
        return {
            type: "FunctionDeclarationStatement",
            target: {
                type: "FunctionName",
                base: luau.identifier(root),
                path: [...prefix, ...path].map(luau.identifier),
                ...spanOf(node),
            },
            isMethod,
            func: this.functionBody(func),
            attributes: node.attributes,
            ...spanOf(node),
        }
    }

    /** `const a, { b } = x, y`. In "assign" mode — a module's top level, where
     *  every name is declared up front — nothing is declared, only assigned. */
    private variableDeclaration(node: T.VariableDeclaration, mode: Mode): L.Statement[] {
        if (mode === "assign" && !node.init.length) {
            // `export let x`: the export exists from here on, holding nil.
            const exported = node.names.flatMap(identifierPatterns).filter(p => this.isRewritten(p))
            return exported.length ? [luau.assign(exported.map(p => this.reference(p)), exported.map(() => luau.nil()))] : []
        }
        const init = node.init.map(e => this.expression(e))
        if (node.names.every(n => n.type === "IdentifierPattern")) {
            const names = node.names as T.IdentifierPattern[]
            return mode === "declare"
                ? [luau.local(names.map(n => this.name(n.name)), init)]
                : [luau.assign(names.map(n => this.reference(n)), init)]
        }
        // `const { a, b } = value` reads straight from `value` when it is a plain
        // name; anything else is evaluated once, into a local.
        const only = node.names.length === 1 && node.init.length === 1 ? node.names[0] : undefined
        if (only && only.type !== "IdentifierPattern") {
            if (init[0].type === "Identifier") return this.destructure(only, init[0], mode)
            const temp = this.names.fresh("ref")
            return [luau.local([temp], init), ...this.destructure(only, luau.identifier(temp), mode)]
        }
        const after: L.Statement[] = []
        const names: string[] = []
        const targets: L.Expression[] = []
        for (const target of node.names) {
            if (target.type === "IdentifierPattern") {
                names.push(this.name(target.name))
                targets.push(this.reference(target))
                continue
            }
            const temp = this.names.fresh("ref")
            names.push(temp)
            targets.push(luau.identifier(temp))
            after.push(...this.destructure(target, luau.identifier(temp), mode))
        }
        if (mode === "declare") return [luau.local(names, init), ...after]
        // Assigning: the temporaries still need declaring.
        const temps = node.names.flatMap((t, i) => (t.type === "IdentifierPattern" ? [] : [names[i]]))
        return [...(temps.length ? [luau.local(temps, [])] : []), luau.assign(targets, init), ...after]
    }

    private assignment(node: T.AssignmentStatement): L.Statement[] {
        if (node.targets.every(t => t.type !== "ObjectPattern" && t.type !== "ArrayPattern")) {
            return [luau.assign(node.targets.map(t => this.expression(t as T.Expression)), node.values.map(e => this.expression(e)))]
        }
        const values = node.values.map(e => this.expression(e))
        const only = node.targets.length === 1 && values.length === 1 ? node.targets[0] : undefined
        if (only && (only.type === "ObjectPattern" || only.type === "ArrayPattern") && values[0].type === "Identifier") {
            const statements = this.destructure(only, values[0], "assign")
            return statements.some(s => s.type === "LocalStatement") ? [luau.doBlock(statements)] : statements
        }
        // Every value is read first, as in `a, b = b, a`, then each target
        // takes its own.
        const temps = node.targets.map(() => this.names.fresh("ref"))
        const body: L.Statement[] = [luau.local(temps, values)]
        node.targets.forEach((target, i) => {
            const value = luau.identifier(temps[i])
            if (target.type === "ObjectPattern" || target.type === "ArrayPattern") {
                body.push(...this.destructure(target, value, "assign"))
            } else {
                body.push(luau.assign([this.expression(target)], [value]))
            }
        })
        return [luau.doBlock(body)]
    }

    // --------------------------------------------------------
    // Destructuring
    // --------------------------------------------------------

    /** Bind (or assign) every name in `pattern` from `source`, which must be a
     *  plain name so that reading it repeatedly has no side effects.
     *
     *  The reads share one statement, in the pattern's order —
     *  `local a, b = source.a, source.b` — with a temporary standing in for a
     *  nested pattern. Defaults, nested patterns and rest follow it. */
    private destructure(pattern: T.ObjectPattern | T.ArrayPattern, source: L.Identifier, mode: Mode): L.Statement[] {
        /** Computed keys, evaluated before anything is read. */
        const keys: { name: string; value: L.Expression }[] = []
        const reads: { name: string; target: L.Expression; value: L.Expression; temp: boolean }[] = []
        const after: L.Statement[] = []

        const bind = (target: T.BindingTarget, value: L.Expression, fallback: T.Expression | undefined): void => {
            if (target.type === "IdentifierPattern") {
                const name = this.name(target.name)
                const reference = mode === "declare" ? luau.identifier(name) : this.reference(target)
                reads.push({ name, target: reference, value, temp: false })
                if (fallback) after.push(this.defaultValue(reference, fallback))
                return
            }
            const name = this.names.fresh("ref")
            reads.push({ name, target: luau.identifier(name), value, temp: true })
            if (fallback) after.push(this.defaultValue(luau.identifier(name), fallback))
            after.push(...this.destructure(target, luau.identifier(name), mode))
        }

        if (pattern.type === "ObjectPattern") {
            const taken: L.Expression[] = []
            for (const property of pattern.properties) {
                let key: L.Expression
                if (!property.computed && (property.key.type === "Identifier" || property.key.type === "StringLiteral")) {
                    const name = property.key.type === "Identifier" ? property.key.name : property.key.value
                    key = luau.string(name)
                    bind(property.value, luau.member(source, name), property.default)
                } else {
                    // A computed key is evaluated once; rest needs it again.
                    const name = this.names.fresh("key")
                    keys.push({ name, value: this.expression(property.key as T.Expression) })
                    key = luau.identifier(name)
                    bind(property.value, luau.index(source, key), property.default)
                }
                taken.push(key)
            }
            if (pattern.rest) {
                // `...rest`: a new table of every key the pattern did not name.
                const rest = this.restTarget(pattern.rest, luau.table([]), mode, after)
                const key = this.names.fresh("key")
                const value = this.names.fresh("value")
                const kept = taken.reduce<L.Expression | undefined>((condition, k) => {
                    const differs = luau.binary("~=", luau.identifier(key), k)
                    return condition ? luau.binary("and", condition, differs) : differs
                }, undefined)
                const copy = luau.assign([luau.index(rest.target, luau.identifier(key))], [luau.identifier(value)])
                after.push(luau.genericFor([key, value], [luau.call(this.builtin("pairs"), [source])], kept ? [luau.ifThen(kept, [copy])] : [copy]))
                after.push(...rest.then)
            }
        } else {
            pattern.elements.forEach((element, i) => {
                if (element) bind(element.value, luau.index(source, luau.number(i + 1)), element.default)
            })
            if (pattern.rest) {
                // `...rest`: a new array of the elements after the named ones.
                const elements = luau.call(luau.member(this.builtin("table"), "move"), [
                    source, luau.number(pattern.elements.length + 1), luau.unary("#", source), luau.number(1), luau.table([]),
                ])
                const rest = this.restTarget(pattern.rest, elements, mode, after)
                after.push(...rest.then)
            }
        }

        const out: L.Statement[] = []
        if (keys.length) out.push(luau.local(keys.map(k => k.name), keys.map(k => k.value)))
        if (mode === "declare") {
            if (reads.length) out.push(luau.local(reads.map(r => r.name), reads.map(r => r.value)))
        } else {
            // Assigning: the temporaries are still new locals.
            const temps = reads.filter(r => r.temp)
            const targets = reads.filter(r => !r.temp)
            if (temps.length) out.push(luau.local(temps.map(r => r.name), temps.map(r => r.value)))
            if (targets.length) out.push(luau.assign(targets.map(r => r.target), targets.map(r => r.value)))
        }
        return [...out, ...after]
    }

    /** Where a rest element's new table goes: straight into its name, or into
     *  a temporary that a nested pattern then destructures (`then`). The
     *  statement creating it is pushed onto `after`. */
    private restTarget(
        target: T.BindingTarget,
        initial: L.Expression,
        mode: Mode,
        after: L.Statement[],
    ): { target: L.Expression; then: L.Statement[] } {
        if (target.type === "IdentifierPattern") {
            if (mode === "declare") {
                const name = this.name(target.name)
                after.push(luau.local([name], [initial]))
                return { target: luau.identifier(name), then: [] }
            }
            const reference = this.reference(target)
            after.push(luau.assign([reference], [initial]))
            return { target: reference, then: [] }
        }
        const name = this.names.fresh("rest")
        after.push(luau.local([name], [initial]))
        return { target: luau.identifier(name), then: this.destructure(target, luau.identifier(name), mode) }
    }

    /** `if target == nil then target = fallback end` */
    private defaultValue(target: L.Expression, fallback: T.Expression): L.Statement {
        return luau.ifThen(luau.binary("==", target, luau.nil()), [luau.assign([target], [this.expression(fallback)])])
    }

    // --------------------------------------------------------
    // Functions
    // --------------------------------------------------------

    private functionBody(func: T.FunctionBody): L.FunctionBody {
        // `function T:m()` has an injected `self`; Luau's `:` supplies it.
        const params = func.isMethod ? func.params.slice(1) : func.params
        const prelude: L.Statement[] = []
        const names = params.map(p => {
            const name = p.pattern ? this.names.fresh("arg") : this.name(p.name)
            if (p.default) prelude.push(this.defaultValue(luau.identifier(name), p.default))
            if (p.pattern) prelude.push(...this.destructure(p.pattern, luau.identifier(name), "declare"))
            return name
        })
        return { ...luau.functionBody(names, [], func.hasVarargs), body: this.block(func.body, prelude) }
    }

    // --------------------------------------------------------
    // Expressions
    // --------------------------------------------------------

    private expression(node: T.Expression): L.Expression {
        switch (node.type) {
            case "Identifier": return this.reference(node)
            case "NilLiteral": return luau.nil()
            case "BooleanLiteral": return luau.boolean(node.value)
            case "NumberLiteral": return luau.number(node.value, node.raw)
            case "StringLiteral": return luau.string(node.value)
            case "VarargExpression": return vararg()
            case "InterpolatedStringExpression": return this.interpolatedString(node)

            case "FunctionExpression":
                return luau.functionExpression(this.functionBody(node.func))

            case "TableExpression": return this.tableExpression(node)
            case "ArrayExpression": return this.arrayExpression(node)

            case "BinaryExpression":
                return luau.binary(node.operator, this.expression(node.left), this.expression(node.right))

            case "UnaryExpression":
                return luau.unary(node.operator, this.expression(node.argument))

            case "MemberExpression":
                return luau.member(this.expression(node.object), node.property.name)

            case "IndexExpression":
                return luau.index(this.expression(node.object), this.expression(node.index))

            case "CallExpression":
                return luau.call(this.expression(node.callee), node.arguments.map(a => this.expression(a)))

            case "MethodCallExpression":
                if (!luau.isLuauName(node.method.name)) {
                    this.report(node.method, `'${node.method.name}' is a Luau keyword and cannot be called with ':'`)
                }
                return luau.methodCall(this.expression(node.object), node.method.name, node.arguments.map(a => this.expression(a)))

            case "ParenthesizedExpression":
                return luau.parenthesized(this.expression(node.expression))

            // Types only: the value is the expression itself.
            case "TypeAssertionExpression":
            case "SatisfiesExpression":
            case "AsConstExpression":
                return this.expression(node.expression)

            case "IfElseExpression":
                return {
                    type: "IfElseExpression",
                    clauses: node.clauses.map(c => ({ condition: this.expression(c.condition), body: this.expression(c.body) })),
                    alternate: this.expression(node.alternate),
                    ...spanOf(node),
                }
        }
    }

    /** `` `${a} any` `` -> `("%s any"):format(tostring(a))` */
    private interpolatedString(node: T.InterpolatedStringExpression): L.Expression {
        let format = ""
        let text = ""
        const args: L.Expression[] = []
        for (const part of node.parts) {
            if (part.kind === "string") {
                format += part.value.replace(/%/g, "%%")
                text += part.value
            } else {
                format += "%s"
                args.push(luau.call(this.builtin("tostring"), [this.expression(part.expression)]))
            }
        }
        if (!args.length) return luau.string(text)
        return luau.methodCall(luau.parenthesized(luau.string(format)), "format", args)
    }

    /** `{ a: 1, b, [k]: v }`. A spread splits the literal into parts that
     *  `assign` copies into one table in order, so a later key still wins. */
    private tableExpression(node: T.TableExpression): L.Expression {
        const parts: L.Expression[] = []
        let current: L.TableField[] = []
        for (const f of node.fields) {
            switch (f.type) {
                case "TableFieldNamed": {
                    const key = f.key.type === "Identifier" ? f.key.name : f.key.value
                    current.push(luau.field(key, this.expression(f.value)))
                    break
                }
                case "TableFieldShorthand":
                    current.push(luau.field(f.name.name, this.reference(f.name)))
                    break
                case "TableFieldComputed":
                    current.push({ type: "TableFieldComputed", key: this.expression(f.key), value: this.expression(f.value) })
                    break
                case "TableFieldSpread":
                    if (current.length) parts.push(luau.table(current))
                    current = []
                    parts.push(this.expression(f.argument))
                    break
            }
        }
        if (parts.length === 0) return luau.table(current)
        if (current.length) parts.push(luau.table(current))
        return luau.call(this.helper("assign"), [luau.table([]), ...parts])
    }

    /** `[1, ...xs, 2]`. Without a spread it is a Luau sequence; with one, the
     *  runs of plain elements and the spread arrays are joined by `concat`. */
    private arrayExpression(node: T.ArrayExpression): L.Expression {
        if (!node.elements.some(e => e.type === "SpreadElement")) {
            return luau.table(node.elements.map(e => ({ type: "TableFieldPositional", value: this.expression(e as T.Expression) })))
        }
        const parts: L.Expression[] = []
        let current: T.Expression[] = []
        const flush = (): void => {
            if (!current.length) return
            // Only a sequence's last value expands to several; inside a run
            // that is not last in the array, keep a call to one value.
            parts.push(luau.table(current.map((e, i) => {
                const value = this.expression(e)
                const last = i === current.length - 1
                return { type: "TableFieldPositional", value: last && expandsToMany(value) ? luau.parenthesized(value) : value }
            })))
            current = []
        }
        for (const element of node.elements) {
            if (element.type === "SpreadElement") {
                flush()
                parts.push(this.expression(element.argument))
            } else {
                current.push(element)
            }
        }
        flush()
        return luau.call(this.helper("concat"), parts)
    }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function spanOf(node: T.BaseNode): L.BaseNode {
    return { line: node.line, column: node.column }
}

function vararg(): L.VarargExpression {
    return { type: "VarargExpression", line: { start: 0, end: 0 }, column: { start: 0, end: 0 } }
}

/** `select("#", ...)` */
function selectCount(select: L.Expression): L.Expression {
    return luau.call(select, [luau.string("#"), vararg()])
}

function expandsToMany(e: L.Expression): boolean {
    return e.type === "CallExpression" || e.type === "MethodCallExpression" || e.type === "VarargExpression"
}

/** `a.b.c` as `["a", "b", "c"]`, or `undefined` for anything else. */
function memberChain(e: L.Expression): string[] | undefined {
    if (e.type === "Identifier") return [e.name]
    if (e.type === "MemberExpression") {
        const base = memberChain(e.object)
        return base && [...base, e.property.name]
    }
    return undefined
}

/** Every name a binding target introduces, as its pattern node. */
function identifierPatterns(target: T.BindingTarget): T.IdentifierPattern[] {
    switch (target.type) {
        case "IdentifierPattern": return [target]
        case "ObjectPattern":
            return [...target.properties.flatMap(p => identifierPatterns(p.value)), ...(target.rest ? identifierPatterns(target.rest) : [])]
        case "ArrayPattern":
            return [
                ...target.elements.flatMap(e => (e ? identifierPatterns(e.value) : [])),
                ...(target.rest ? identifierPatterns(target.rest) : []),
            ]
    }
}

/** Where the top level declares the value `name`, as the node its binding records. */
function topLevelDeclaration(
    statements: readonly T.Statement[],
    name: string,
): { type: "ImportStatement" | "Declaration"; node: object } | undefined {
    for (const statement of statements) {
        const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
        if (declaration.type === "VariableDeclaration") {
            const pattern = declaration.names.flatMap(identifierPatterns).find(p => p.name === name)
            if (pattern) return { type: "Declaration", node: pattern }
        } else if (declaration.type === "FunctionDeclaration" && declaration.name.name === name) {
            return { type: "Declaration", node: declaration.name }
        } else if (declaration.type === "ImportStatement") {
            const local = declaration.defaultImport?.name === name
                ? declaration.defaultImport
                : declaration.specifiers.find(s => s.local.name === name)?.local
            if (local) return { type: "ImportStatement", node: local }
        }
    }
    return undefined
}

/** A readable local name for a required module: `src/shared/util` -> `util`. */
function moduleName(key: string): string {
    const last = key.split("/").filter(Boolean).pop() ?? "module"
    const cleaned = last.replace(/[^A-Za-z0-9_]/g, "_")
    return /^[A-Za-z_]/.test(cleaned) && !luau.LUAU_KEYWORDS.has(cleaned) ? cleaned : `module_${cleaned}`
}
