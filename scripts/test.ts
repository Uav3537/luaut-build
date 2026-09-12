/**
 * luaut-build tests.
 *
 * Lowering cases compile a fragment and compare the Luau it prints, with the
 * printer's line breaks folded into spaces so a case reads on one line. Every
 * output is parsed back with luau-parser: whatever lowering builds must be
 * valid Luau.
 *
 * Bundle cases build a small project on disk. When a Luau interpreter is
 * available — `luau` on the PATH, or the `LUAU` environment variable naming
 * one — each bundle is also run, and what it prints is compared: that is the
 * only way to know a cycle really behaves like ES modules.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseLuau } from "luau-parser"
import { bundle, compile, type BundleResult } from "../src/index.js"

let passed = 0
let skipped = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) { passed++; return }
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

const flat = (code: string): string => code.trim().split("\n").join(" ")

function validLuau(name: string, code: string): void {
    try {
        parseLuau(code)
    } catch (error) {
        failures.push(`${name}\n    output is not valid Luau: ${(error as Error).message}\n${code}`)
    }
}

/** Compile `source` and check its output, on one line. */
async function lowers(name: string, source: string, expected: string): Promise<void> {
    const result = await compile(source)
    if (result.code === undefined) {
        failures.push(`${name}\n    did not compile: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    check(name, flat(result.code), expected)
}

// --- declarations ---------------------------------------------------------------
await lowers("const and let are local", "const a = 1\nlet b, c = 2, 3", "local a = 1; local b, c = 2, 3;")
await lowers("a declaration without a value", "let x", "local x;")
await lowers("types are dropped", "type P = { x: number }\ndeclare game: unknown\nconst n: number = 1 as number", "local n = 1;")
await lowers("satisfies and as const are dropped", "const t = { a: 1 } satisfies { a: number }\nconst u = [1] as const", "local t = { a = 1 }; local u = { 1 };")

// --- object destructuring --------------------------------------------------------
await lowers("reads straight from a name", "const { a, b } = value", "local a, b = value.a, value.b;")
await lowers("renames", "const { a: x, b: y } = value", "local x, y = value.a, value.b;")
await lowers("anything but a name is evaluated once",
    "const { a, b } = load()", "local ref = load(); local a, b = ref.a, ref.b;")
await lowers("defaults apply to nil",
    "const { a = 1 } = value", "local a = value.a; if a == nil then a = 1; end;")
await lowers("nested patterns keep their place in the read",
    "const { a, b: { c }, d } = value", "local a, ref, d = value.a, value.b, value.d; local c = ref.c;")
await lowers("a string key that is not a name",
    `const { "has-dash": dash } = value`, `local dash = value["has-dash"];`)
await lowers("a computed key is evaluated first",
    "const { [key()]: v } = value", "local key2 = key(); local v = value[key2];")
await lowers("rest takes the other keys",
    "const { a, ...others } = value",
    `local a = value.a; local others = {}; for key, value2 in pairs(value) do if key ~= "a" then others[key] = value2; end; end;`)
await lowers("destructuring beside plain names",
    "const x, { y } = f()", "local x, ref = f(); local y = ref.y;")

// --- array destructuring ---------------------------------------------------------
await lowers("arrays read by index", "const [first, second] = list", "local first, second = list[1], list[2];")
await lowers("holes are skipped", "const [, second] = list", "local second = list[2];")
await lowers("array rest", "const [head, ...tail] = list", "local head = list[1]; local tail = table.move(list, 2, #list, 1, {});")

// --- destructuring assignment ----------------------------------------------------
await lowers("assigns straight from a name", "let a, b = 1, 2\n{ a, b } = value", "local a, b = 1, 2; a, b = value.a, value.b;")
await lowers("assignment from anything else is scoped",
    "let a, b = 1, 2\n{ a, b } = { a: b, b: a }", "local a, b = 1, 2; do local ref = { a = b, b = a }; a, b = ref.a, ref.b; end;")

// --- tables, arrays and strings --------------------------------------------------
await lowers("object literals", `const t = { a: 1, "b-c": 2, [k]: 3, d }`, `local t = { a = 1, ["b-c"] = 2, [k] = 3, d = d };`)
await lowers("array literals are tables", "const xs = [1, 2, 3]", "local xs = { 1, 2, 3 };")
await lowers("object spread copies in order",
    "const t = { a: 1, ...base, b: 2 }",
    `local function luaut_assign(target, ...) for i = 1, select("#", ...) do local source = select(i, ...); if source ~= nil then for key, value in pairs(source) do target[key] = value; end; end; end; return target; end; local t = luaut_assign({}, { a = 1 }, base, { b = 2 });`)
await lowers("array spread joins the runs",
    "const xs = [f(), ...ys, g()]",
    `local function luaut_concat(...) local result = {}; for i = 1, select("#", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; return result; end; local xs = luaut_concat({ (f()) }, ys, { (g()) });`)
await lowers("interpolation becomes format", "print(`${a} any`)", `print(("%s any"):format(tostring(a)));`)
await lowers("interpolation escapes percent signs and keeps braces",
    "print(`${n}% of {total}`)", `print(("%s%% of {total}"):format(tostring(n)));`)
await lowers("a template without interpolation is a string", "print(`plain`)", `print("plain");`)

// --- functions -------------------------------------------------------------------
await lowers("function is a local function", "function f(a: number): number\n    return a\nend", "local function f(a) return a; end;")
await lowers("parameter defaults", "function f(a = 1)\nend", "local function f(a) if a == nil then a = 1; end; end;")
await lowers("destructured parameters",
    "function f({ x, y }, [z])\nend", "local function f(arg, arg2) local x, y = arg.x, arg.y; local z = arg2[1]; end;")
await lowers("methods keep ':' and drop the injected self",
    "holder = {}\nfunction holder:go(n: number)\n    return self\nend", "holder = {}; function holder:go(n) return self; end;")
await lowers("function expressions", "const f = function(a = 2) return a end", "local f = function(a) if a == nil then a = 2; end; return a; end;")

// --- statements and names --------------------------------------------------------
await lowers("for-in patterns", "for _, { name } in pairs(t) do\n    print(name)\nend", "for _, item in pairs(t) do local name = item.name; print(name); end;")
await lowers("if expressions", "const v = if a then 1 elseif b then 2 else 3", "local v = if a then 1 elseif b then 2 else 3;")
await lowers("a Luau keyword used as a name", "let local = 1\nprint(t.local, local)", `local local_ = 1; print(t["local"], local_);`)
await lowers("generated names avoid the source's", "const ref = 1\nconst { a } = f()", "local ref = 1; local ref2 = f(); local a = ref2.a;")

await lowers("for x in a table yields the values", "const list = [1, 2]\nfor v in list do print(v) end",
    "local list = { 1, 2 }; for _, v in list do print(v); end;")
await lowers("an iterator function keeps its own values", "for k in pairs(t) do print(k) end", "for k in pairs(t) do print(k); end;")
await lowers("attributes are kept", "@native\nfunction f(x: number): number\n    return x\nend", "@native local function f(x) return x; end;")
await lowers("a shadowed global the output needs is captured first",
    "const table = {}\nconst [a, ...rest] = list\nprint(`${a}`)",
    `local luaut_table = table; local table = {}; local a = list[1]; local rest = luaut_table.move(list, 2, #list, 1, {}); print(("%s"):format(tostring(a)));`)

check("a parse error leaves no output",
    ((r: { code?: string; diagnostics: unknown[] }) => [r.code, r.diagnostics.length > 0])(await compile("const = 1")), [undefined, true])
check("reassigning a const is an error",
    (await compile("const a = 1\na = 2")).diagnostics.map(d => d.message), ["Cannot assign to 'a' — it is a const"])
await lowers("import type is erased", `import type { Shape } from "./m"\nconst s: Shape = { r: 1 }`, "local s = { r = 1 };")
check("modules need a bundle",
    (await compile(`import { a } from "./m"`)).diagnostics.map(d => d.message), ["Imports and exports need a bundle: build the project with luaut-build"])

// --- bundles ---------------------------------------------------------------------

const luauBinary = findLuau()

function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "luaut-build-"))
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    return root
}

/** The real `@luaut/lua`, copied where a temp project resolves it from — the
 *  array and string methods live there, not in the compiler. */
function installLua(root: string): void {
    const from = fileURLToPath(new URL("../node_modules/@luaut/lua/", import.meta.url))
    for (const file of ["package.json", "index.d.luaut", "lowering.mjs", "runtime/array.luau", "runtime/string.luau"]) {
        const target = join(root, "node_modules", "@luaut", "lua", file)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(join(from, file), "utf8"))
    }
}

/** Run a bundle and return what it printed, or `undefined` without an interpreter. */
function run(name: string, result: BundleResult): string[] | undefined {
    if (result.code === undefined) {
        failures.push(`${name}\n    no bundle: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return undefined
    }
    validLuau(name, result.code)
    if (!luauBinary) {
        skipped++
        return undefined
    }
    const file = join(mkdtempSync(join(tmpdir(), "luaut-run-")), "bundle.luau")
    writeFileSync(file, result.code)
    try {
        return execFileSync(luauBinary, [file], { encoding: "utf8" }).trim().split(/\r?\n/)
    } catch (error) {
        failures.push(`${name}\n    the bundle failed: ${(error as { stderr?: string }).stderr ?? error}`)
        return undefined
    }
}

function runs(name: string, result: BundleResult, expected: string[]): void {
    const output = run(name, result)
    if (output) check(name, output, expected)
}

/** Run a bundle that should fail, and check its error mentions `message`. */
function fails(name: string, result: BundleResult, message: string): void {
    if (result.code === undefined) {
        failures.push(`${name}\n    no bundle: ${result.diagnostics.map(d => d.message).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    if (!luauBinary) {
        skipped++
        return
    }
    const file = join(mkdtempSync(join(tmpdir(), "luaut-run-")), "bundle.luau")
    writeFileSync(file, result.code)
    try {
        execFileSync(luauBinary, [file], { encoding: "utf8", stdio: "pipe" })
        failures.push(`${name}\n    the bundle ran without an error`)
    } catch (error) {
        const output = `${(error as { stderr?: string }).stderr ?? ""}${(error as { stdout?: string }).stdout ?? ""}`
        check(name, output.includes(message), true)
        if (!output.includes(message)) failures.push(`    got: ${output.trim()}`)
    }
}

{
    const root = project({
        "luaut.config.json": JSON.stringify({ types: [], paths: { "@/*": ["src/*"] }, sourceMap: null }),
        "src/main.luaut": `import { twice } from "./math"\nimport { NAME } from "@/names"\nprint(twice(21), NAME)\n`,
        "src/math.luaut": "export function twice(n: number): number\n    return n * 2\nend\n",
        "src/names.luaut": `export const NAME = "luaut"\n`,
    })
    const result = await bundle({ entry: join(root, "src/main.luaut") })
    check("bundle: every module the entry reaches, named from the config's folder",
        result.modules, ["src/main", "src/math", "src/names"])
    runs("bundle: imports through relative paths and aliases", result, ["42\tluaut"])
}

{
    // a imports b, which imports a back while a is still loading.
    const root = project({
        "main.luaut": `import { a1, counter, bump } from "./a"\nprint("main", a1())\nbump()\nbump()\nprint("counter", counter)\n`,
        "a.luaut": [
            `import { readLate } from "./b"`,
            `export let counter = 0`,
            `export function a1(): string return "a1" end`,
            `export function hoisted(): string return "hoisted" end`,
            `export function bump() counter += 1 end`,
            `export const late = "late"`,
            `print("a sees", readLate())`,
        ].join("\n"),
        "b.luaut": [
            `import { hoisted, late } from "./a"`,
            `print("b during the cycle", hoisted())`,
            `export function readLate(): string return late end`,
        ].join("\n"),
    })
    runs("bundle: a cycle sees hoisted functions at once, and later values live",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        ["b during the cycle\thoisted", "a sees\tlate", "main\ta1", "counter\t2"])
}

{
    // Reading what the other module has not initialized yet is an error, as in ES modules.
    const root = project({
        "main.luaut": `import { value } from "./a"\nprint(value)\n`,
        "a.luaut": `import { early } from "./b"\nexport const value = early\n`,
        "b.luaut": `import { value } from "./a"\nexport const early = value\n`,
    })
    fails("bundle: a value read across a cycle before it is initialized is an error",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        "Cannot access 'value' before initialization: 'a' has not reached it yet")
}

{
    // Re-exports are references: a later change shows through them.
    const root = project({
        "main.luaut": `import { count, bump } from "./re"\nimport * as All from "./all"\nprint(count, All.count)\nbump()\nprint(count, All.count)\n`,
        "state.luaut": `export let count = 0\nexport function bump() count += 1 end\n`,
        "re.luaut": `export { count, bump } from "./state"\n`,
        "all.luaut": `export * from "./state"\n`,
    })
    runs("bundle: re-exports and export * stay live",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["0\t0", "1\t1"])
}

{
    const root = project({
        "main.luaut": `import * as Util from "./util"\nprint(Util.twice(4), Util.NAME, Util.default)\n`,
        "util.luaut": `export function twice(n: number): number return n * 2 end\nexport const NAME = "util"\nexport default true\n`,
    })
    runs("bundle: import * as", await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["8\tutil\ttrue"])
}

{
    const root = project({
        "main.luaut": `import { value } from "./m"\nvalue = 2\n`,
        "m.luaut": `export let value = 1\n`,
    })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: assigning to an import is an error, and leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["scope", "Cannot assign to 'value' — it is an import"]]])
}

{
    const root = project({
        "main.luaut": `import { later, set } from "./m"\nprint(later)\nset()\nprint(later)\n`,
        "m.luaut": `export let later\nexport function set() later = "set" end\n`,
    })
    runs("bundle: `export let` without a value is initialized to nil",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["nil", "set"])
}

{
    const root = project({
        "main.luaut": `import def, { x as y } from "./m"\nimport { all } from "./re"\nprint(def.v, y, all)\n`,
        "m.luaut": `export const x = "x"\nexport default { v: "default" }\n`,
        "re.luaut": `export * from "./m"\nexport { x as all } from "./m"\n`,
    })
    runs("bundle: default, renamed and re-exported names",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["default\tx\tx"])
}

{
    const root = project({
        "main.luaut": `import { Shape } from "./types"\nimport { value } from "./values"\nconst s: Shape = { r: value }\nprint(s.r)\n`,
        "types.luaut": "export type Shape = { r: number }\n",
        "values.luaut": "export const value = 3\n",
    })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a module imported only for types is left out", result.modules, ["main", "values"])
    runs("bundle: and the rest still runs", result, ["3"])
}

{
    // `import type` is erased whatever it names: even a module whose code
    // would run is never required for it.
    const root = project({
        "main.luaut": `import type { Shape, noisy } from "./noisy"\nimport type * as N from "./noisy"\nconst s: Shape = { r: 1 }\nconst f: typeof noisy = function() end\nconst n: N.Shape = s\nprint(s.r, n.r)\n`,
        "noisy.luaut": `print("noisy ran")\nexport type Shape = { r: number }\nexport function noisy() end\n`,
    })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a module reached only through import type is left out", result.modules, ["main"])
    runs("bundle: and never runs", result, ["1\t1"])
}

{
    const root = project({
        "main.luaut": `import type { value } from "./m"\nprint(value)\n`,
        "m.luaut": `export const value = 1\n`,
    })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a type-only import used as a value is an error, and leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["scope", "'value' is imported with 'import type' and can only be used as a type"]]])
}

{
    const root = project({ "main.luaut": `export const answer = 42\n` })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: an entry that exports returns its exports", flat(result.code ?? "").endsWith(`return G.require("main");`), true)
}

{
    const root = project({ "main.luaut": `import { nope } from "./missing"\nprint(nope)\n` })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a module that cannot be found leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["module", "Cannot find module './missing'"]]])
}

{
    const root = project({ "main.luaut": `const n: number = "text"\nprint(n)\n` })
    const result = await bundle({ entry: join(root, "main.luaut"), config: { types: ["./defs.d.luaut"] } })
    check("bundle: type errors are reported and the bundle is still written",
        [result.code !== undefined, result.diagnostics.filter(d => d.category === "type").map(d => d.message)],
        [true, [`Type '"text"' is not assignable to 'number'`]])
}

{
    // Most of the language in one program, checked by what it prints.
    const root = project({
        "main.luaut": [
            `import { Stack } from "./stack"`,
            `type Point = { x: number, y: number }`,
            `const table = { note: "shadows the global" }`,
            `const point: Point = { x: 1, y: 2 }`,
            `const { x, y: py = 9, ...others } = { ...point, z: 3, w: 4 }`,
            `let count = 0`,
            `for key in pairs(others) do count += 1 end`,
            `const [first, , third = "three", ...tail] = ["one", "two", nil, "four", "five"]`,
            `function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number`,
            `    return (a + b) * scale`,
            `end`,
            `const values = [0, ...[1, 2], sum({ a: 1 }), sum({ a: 1, b: 1 }, 2)]`,
            `let total = 0`,
            `for v in values do total += v end`,
            `const stack = Stack.new()`,
            `stack:push(5)`,
            `const label = if total > 10 then "big" else "small"`,
            `let a, b = 1, 2`,
            `{ a, b } = { a: b, b: a }`,
            `print(\`\${x} \${py} \${count} \${first} \${third} \${#tail} \${total} \${label} \${stack:size()} \${a}\${b} 100%\`, table.note, ...)`,
        ].join("\n"),
        "stack.luaut": [
            `export const Stack = {}`,
            `Stack.__index = Stack`,
            `function Stack.new()`,
            `    return setmetatable({ items: [] }, Stack)`,
            `end`,
            `function Stack:push(value: number)`,
            `    table.insert(self.items, value)`,
            `end`,
            `function Stack:size(): number`,
            `    return #self.items`,
            `end`,
        ].join("\n"),
    })
    runs("bundle: the language at runtime",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        ["1 2 2 one three 2 18 big 1 21 100%\tshadows the global"])
}

{
    const root = project({ "main.luaut": `const G = 1\nprint(G)\n` })
    runs("bundle: the module table avoids the modules' names",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["1"])
}

{
    const root = project({
        "main.luaut": [
            `type Node = { name: string, child: Node | nil, greet: (self: Node, suffix: string) -> string, pair: () -> (number, number) }`,
            `let reads = 0`,
            `let argued = 0`,
            `function arg(): string`,
            `    argued += 1`,
            `    return "!"`,
            `end`,
            `function make(name: string, child: Node | nil): Node`,
            `    return { name, child, greet: function(self: Node, suffix: string): string return self.name .. suffix end, pair: function(): (number, number) return 1, 2 end }`,
            `end`,
            `const leaf = make("leaf", nil)`,
            `const root = make("root", leaf)`,
            `const none: Node | nil = nil`,
            `function get(n: Node | nil): Node | nil`,
            `    reads += 1`,
            `    return n`,
            `end`,
            `print(root?.name, none?.name, root?.child?.name, leaf?.child?.name)`,
            `print(root?:greet(arg()), none?:greet(arg()), argued)`,
            `print(get(root)?.child?.name, get(none)?.child?.name, reads)`,
            `print(root?.child:greet("?"), (none?.child) == nil)`,
            `print(root?.pair())`,
            `none?:greet(arg())`,
            `root?.child?:greet(arg())`,
            `get(root)?.child?:greet(arg())`,
            `print(argued, reads)`,
            `function spread(...: Node | nil): string | nil`,
            `    return (...)?.child?.name`,
            `end`,
            `print(spread(root), spread(nil))`,
        ].join("\n"),
    })
    runs("bundle: optional chains",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        [
            "root\tnil\tleaf\tnil",
            "root!\tnil\t1",
            "leaf\tnil\t2",
            "leaf?\ttrue",
            "1\t2",
            "3\t3",
            "leaf\tnil",
        ])
    const code = (await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })).code ?? ""
    check("bundle: an optional read on a name is an `if` expression",
        code.includes("if root == nil then nil else root.name"), true)
}

// What a call means is the type library's to say: the compiler asks, the
// library answers with what to call instead and the Luau behind it.
{
    const lowering = [
        "const runtime = [",
        "    'local __NAME__ = {}',",
        "    'function __NAME__.first(t) return t[1] end',",
        "    'function __NAME__.shout(s) return string.upper(s) .. \"!\" end',",
        "].join('\\n')",
        "",
        "export default {",
        "    runtime: { own: runtime },",
        "    methodCall({ method, receiver, use }) {",
        "        const array = receiver?.kind === 'array' || receiver?.kind === 'tuple'",
        "        const text = receiver?.kind === 'primitive' && receiver.name === 'string'",
        "        const literal = receiver?.kind === 'literal' && receiver.base === 'string'",
        "        if (array && method === 'first') return { callee: `${use('own')}.first` }",
        "        if ((text || literal) && method === 'shout') return { callee: `${use('own')}.shout` }",
        "        return undefined",
        "    },",
        "}",
    ].join("\n")
    const manifest = (extra: Record<string, unknown> = {}): string => JSON.stringify({
        name: "@luaut/own",
        luaut: { types: "index.d.luaut", lowering: "lowering.mjs", ...extra },
    })
    const definitions = [
        "declare function print(...: unknown): ()",
        "type ArrayMethods<T> = { first: (self: T[]) -> T | nil, nope: (self: T[]) -> T | nil }",
        "type StringMethods = { shout: (self: string) -> string }",
    ].join("\n")

    const root = project({
        "node_modules/@luaut/own/package.json": manifest(),
        "node_modules/@luaut/own/index.d.luaut": definitions,
        "node_modules/@luaut/own/lowering.mjs": lowering,
        "main.luaut": `print(([3, 4]):first(), ("hi"):shout())`,
    })
    runs("bundle: a type library's own lowering",
        await bundle({ entry: join(root, "main.luaut"), config: { types: ["own"] } }), ["3\tHI!"])

    const claimed = (await bundle({ entry: join(root, "main.luaut"), config: { types: ["own"] } })).code ?? ""

    // Declared in the types but not lowered: left as a method call, for the
    // value itself to answer.
    const unclaimed = project({
        "node_modules/@luaut/own/package.json": manifest(),
        "node_modules/@luaut/own/index.d.luaut": definitions,
        "node_modules/@luaut/own/lowering.mjs": lowering,
        "main.luaut": "const v = ([1]):nope()\n",
    })
    const left = (await bundle({ entry: join(unclaimed, "main.luaut"), config: { types: ["own"] } })).code ?? ""

    // And with no library at all, nothing is lowered.
    const bare = project({ "main.luaut": "const v = ([1]):first()\n" })
    const plain = (await bundle({ entry: join(bare, "main.luaut"), config: { types: [] } })).code ?? ""

    check("bundle: the library's runtime is emitted once, and only what it claims", [
        claimed.includes("function luaut_own.first"),
        (claimed.match(/local luaut_own = /g) ?? []).length,
        left.includes(":nope()"),
        plain.includes(":first()"),
    ], [true, 1, true, true])

    // A module that will not load is reported, and the build goes on.
    const broken = project({
        "node_modules/@luaut/own/package.json": manifest(),
        "node_modules/@luaut/own/index.d.luaut": definitions,
        "node_modules/@luaut/own/lowering.mjs": "export default",
        "main.luaut": "const v = ([1]):first()\n",
    })
    const result = await bundle({ entry: join(broken, "main.luaut"), config: { types: ["own"] } })
    check("bundle: a lowering module that will not load is a problem, not a crash", [
        result.diagnostics.some(d => d.message.includes("failed to load")),
        (result.code ?? "").includes(":first()"),
    ], [true, true])
}

{
    const root = project({
        "main.luaut": [
            `const names = ["bb", "a", "ccc"]`,
            `print(names:filter(function(v) return #v > 1 end):join(","))`,
            `print(names:map(function(v) return #v end):join(","))`,
            `print(names:find(function(v) return #v == 1 end), names:findIndex(function(v) return #v == 1 end))`,
            `print(names:join("-"), names:includes("a"), names:indexOf("ccc"), names:indexOf("nope"))`,
            `print(names:some(function(v) return #v == 3 end), names:every(function(v) return #v == 3 end))`,
            `print(names:slice(2):join(","), names:slice(1, 2):join(","), names:slice(-2):join(","))`,
            `const copy = names:slice()`,
            `print(copy:sort():join(","), names:join(","))`,
            `print(copy:reverse():join(","))`,
            `print(names:concat(["d"], ["e", "f"]):join(","))`,
            `print(([[1, 2], [3]]):flat():join(","))`,
            `print(([1, 2, 3]):reduce(function(sum, v) return sum + v end, 0))`,
            `const stack = [1, 2]`,
            `print(stack:push(3), stack:join(","), stack:pop(), stack:join(","))`,
            `print(stack:shift(), stack:join(","), stack:unshift(9, 8), stack:join(","))`,
            `let seen = ""`,
            `names:forEach(function(v, i) seen = seen .. i .. v end)`,
            `print(seen)`,
        ].join("\n"),
    })
    installLua(root)
    runs("bundle: the array methods",
        await bundle({ entry: join(root, "main.luaut"), config: { types: ["lua"] } }),
        [
            "bb,ccc",
            "2,1,3",
            "a\t2",
            "bb-a-ccc\ttrue\t3\tnil",
            "true\tfalse",
            "a,ccc\tbb,a\ta,ccc",
            "a,bb,ccc\tbb,a,ccc",
            "ccc,bb,a",
            "bb,a,ccc,d,e,f",
            "1,2,3",
            "6",
            "3\t1,2,3\t3\t1,2",
            "1\t2\t3\t9,8,2",
            "1bb2a3ccc",
        ])
}

{
    const root = project({
        "main.luaut": [
            `print(("  hi  "):trim() .. "|", ("  hi"):trimStart() .. "|", ("hi  "):trimEnd() .. "|")`,
            `print(("hello"):startsWith("he"), ("hello"):endsWith("lo"), ("hello"):includes("ell"))`,
            `print(("hello"):indexOf("l"), ("hello"):indexOf("z"))`,
            `print(("hello"):slice(2, 3), ("hello"):slice(-2))`,
            `print(("a.b.c"):replace(".", "-"), ("a.b.c"):replaceAll(".", "-"))`,
            `print(("7"):padStart(3, "0"), ("7"):padEnd(3, "."), ("abc"):padStart(2, "0"))`,
            `print(("x"):upper(), ("Y"):lower())`,
        ].join("\n"),
    })
    installLua(root)
    runs("bundle: the string methods, Luau's own left alone",
        await bundle({ entry: join(root, "main.luaut"), config: { types: ["lua"] } }),
        [
            "hi|\thi|\thi|",
            "true\ttrue\ttrue",
            "3\tnil",
            "el\tlo",
            "a-b.c\ta-b-c",
            "007\t7..\tabc",
            "X\ty",
        ])
    const code = (await bundle({ entry: join(root, "main.luaut"), config: { types: ["lua"] } })).code ?? ""
    check("bundle: a string's own Luau methods stay method calls",
        [code.includes(`("x"):upper()`), code.includes("luaut_string.trim")], [true, true])
}

{
    const root = project({
        "main.luaut": [
            `let argued = 0`,
            `function arg(): string`,
            `    argued += 1`,
            `    return "!"`,
            `end`,
            `const call: ((s: string) -> string) | nil = function(s: string): string return "got" .. s end`,
            `const none: ((s: string) -> string) | nil = nil`,
            `print(call?.(arg()), none?.(arg()), argued)`,
            `none?.(arg())`,
            `call?.(arg())`,
            `print(argued)`,
            `type Names = "a" | "b"`,
            `const per = { a: function(): string return "A" end } as const satisfies { [Names]: () -> string }`,
            `let key: Names = "a"`,
            `print(per[key]?.())`,
            `key = "b"`,
            `print(per[key]?.())`,
        ].join("\n"),
    })
    runs("bundle: optional calls",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        ["got!\tnil\t1", "2", "A", "nil"])
}

{
    const root = project({
        "main.luaut": [
            `const a = 1`,
            `--@luaut-ignore`,
            `a = 2`,
            `const n: number = "x" --@luaut-expect-error covers the next line of code, not its own`,
            `--@luaut-expect-error`,
            `print(a)`,
        ].join("\n"),
        "quiet.luaut": `--@luaut-nocheck\nconst b = 1\nb = 2\nconst s: number = "x"\n`,
    })
    const loud = await bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: directives suppress scope and type errors, and an unused expect-error is one",
        loud.diagnostics.map(d => `${d.line}: ${d.message}`),
        ["4: Type '\"x\"' is not assignable to 'number'", "4: Unused '@luaut-expect-error' directive", "5: Unused '@luaut-expect-error' directive"])
    const unknown = project({
        "main.luaut": `counter = 1\nprint(counter)\nprint(typo)\n`,
        "defs.d.luaut": `declare function print(...: unknown): ()\n`,
    })
    const withUnknown = await bundle({ entry: join(unknown, "main.luaut"), config: { types: ["./defs.d.luaut"] } })
    check("bundle: a name nothing declares is reported, and still builds",
        [withUnknown.diagnostics.map(d => d.message), withUnknown.code !== undefined], [["Cannot find name 'typo'"], true])
    const quiet = await bundle({ entry: join(root, "quiet.luaut"), config: { types: [] } })
    check("bundle: nocheck builds a file with scope errors", [quiet.diagnostics, quiet.code !== undefined], [[], true])
}

{
    const source = [
        `let Resource: ReturnType<typeof Load> | nil`,
        `const early = parity(4)`,
        `function Load()`,
        `    return { level: Config.level, even: parity(4) }`,
        `end`,
        `function parity(n: number): string`,
        `    function isEven(k: number): boolean`,
        `        if k == 0 then return true end`,
        `        return isOdd(k - 1)`,
        `    end`,
        `    function isOdd(k: number): boolean`,
        `        if k == 0 then return false end`,
        `        return isEven(k - 1)`,
        `    end`,
        `    return if isEven(n) then "even" else "odd"`,
        `end`,
        `const Config = { level: 3 }`,
        `Resource = Load()`,
        `print(early, Resource.level, Resource.even, parity(3))`,
    ].join("\n")
    const root = project({ "main.luaut": source })
    runs("bundle: functions are hoisted, and see the module's later names",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["even\t3\teven\todd"])
    // Outside a bundle: the same, as one file.
    const single = await compile(source)
    check("compile: a function used above its declaration is hoisted whole", single.diagnostics.map(d => d.message), [])
    if (single.code !== undefined) runs("compile: hoisted functions run", { code: single.code, diagnostics: [], modules: [] } as unknown as BundleResult, ["even\t3\teven\todd"])
}

{
    const root = project({
        "tags.luaut": [
            "export function Tags(a: number, b: number): boolean",
            "export function Tags(a?: number, b?: number): string",
            "export function Tags(a: number = 1, b?: number): string",
            "    return tostring(a) .. tostring(b)",
            "end",
        ].join("\n"),
        "main.luaut": `import { Tags } from "./tags"\nprint(Tags(1, 2))\n`,
        "defs.d.luaut": "declare function print(...: unknown): ()\ndeclare function tostring(value: unknown): string\n",
    })
    runs("bundle: an exported overload set is one function",
        await bundle({ entry: join(root, "main.luaut"), config: { types: ["./defs.d.luaut"] } }), ["12"])
}

{
    const source = [
        "function Setup()",
        "    let EventManager = {",
        "        Connections: [1, 2],",
        "        Count: function()",
        "            return #EventManager.Connections",
        "        end",
        "    }",
        "    return EventManager",
        "end",
        "function Sibling()",
        "    const read = function() return later end",
        "    const later = 7",
        "    return read()",
        "end",
        "const shadow = 1",
        "do",
        "    const shadow = shadow + 1",
        "    print(Setup().Count(), Sibling(), shadow)",
        "end",
    ].join("\n")
    const root = project({ "main.luaut": source })
    runs("bundle: a closure reads the name its own value is bound to",
        await bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["2\t7\t2"])
    const single = await compile(source)
    if (single.code !== undefined) {
        runs("compile: the same outside a bundle",
            { code: single.code, diagnostics: [], modules: [] } as unknown as BundleResult, ["2\t7\t2"])
    }
}

function findLuau(): string | undefined {
    const candidates = [process.env.LUAU, "luau"].filter((c): c is string => !!c)
    const empty = join(mkdtempSync(join(tmpdir(), "luaut-probe-")), "empty.luau")
    writeFileSync(empty, "")
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, [empty], { stdio: "ignore" })
            return candidate
        } catch {
            // not this one
        }
    }
    return undefined
}

for (const failure of failures) console.log(`FAIL ${failure}`)
const note = luauBinary ? "" : ` (${skipped} runs skipped: no Luau interpreter; set LUAU to run them)`
console.log(`\n${passed} passed, ${failures.length} failed${note}`)
process.exit(failures.length ? 1 : 0)
