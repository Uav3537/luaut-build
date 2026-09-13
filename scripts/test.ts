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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

// A rest parameter is Lua's `{...}` under a name: the function still takes
// `...`, and the array of it is a local.
await lowers("a rest parameter is the varargs, named",
    ["function join(sep, ...parts)", "    return parts", "end"].join("\n"),
    "local function join(sep, ...) local parts = { ... }; return parts; end;")

await lowers("an array of the varargs is Lua's own table of them",
    ["function join(...)", "    const parts = [...]", "    return parts", "end"].join("\n"),
    "local function join(...) local parts = { ... }; return parts; end;")

// --- classes ----------------------------------------------------------------
// What a class lowers to is one table per class and one table per instance,
// with the instance's metatable pointing at the class — so the only way to be
// sure is to run it.
{
    const root = project({
        "luaut.config.json": JSON.stringify({ types: [], sourceMap: null }),
        "shape.luaut": [
            "export class Shape",
            "    name: string",
            "    sides = 0",
            "    static made = 0",
            "    constructor(name: string)",
            "        this.name = name",
            "        Shape.made += 1",
            "    end",
            "    function area(): number",
            "        return 0",
            "    end",
            "    function describe(): string",
            "        return this.name .. \" has area \" .. tostring(this:area())",
            "    end",
            "    get label(): string",
            "        return \"<\" .. this.name .. \">\"",
            "    end",
            "    set label(value: string)",
            "        this.name = value",
            "    end",
            "    static function count(): number",
            "        return Shape.made",
            "    end",
            "end",
            "",
        ].join("\n"),
        "main.luaut": [
            `import { Shape } from "./shape"`,
            "",
            "class Square extends Shape",
            "    side: number",
            "    sides = 4",
            "    constructor(side: number)",
            `        super("square")`,
            "        this.side = side",
            "    end",
            "    function area(): number",
            "        return this.side * this.side",
            "    end",
            "    function describe(): string",
            `        return super.describe() .. " (square)"`,
            "    end",
            "end",
            "",
            "-- No constructor of its own: it takes what Square takes.",
            "class Tile extends Square",
            "end",
            "",
            "const s = new Square(3)",
            "print(s:describe())",
            "print(s.label, s.sides, s.side)",
            "s.label = \"box\"",
            "print(s:describe())",
            "",
            "const t = new Tile(2)",
            "print(t:describe(), t.label)",
            "print(Shape.count(), Square.count(), Square.made)",
            "",
            "-- The instance points at the class, so a method added to the class",
            "-- afterwards is there on instances already built.",
            "print(getmetatable(s) == Square, getmetatable(t) == Tile)",
            "",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.luaut") })
    check("class: the bundle type-checks", result.diagnostics.map(d => d.message), [])
    runs("class: instances, inheritance, super, accessors and statics", result, [
        "square has area 9 (square)",
        "<square>\t4\t3",
        "box has area 9 (square)",
        "square has area 4 (square)\t<square>",
        "2\t2\t2",
        "true\ttrue",
    ])
}

// The memory model, as the language promises it: an instance points at its
// class, a class points at the one it extends, and nothing is copied per
// instance. Only running it can show that.
{
    const root = project({
        "luaut.config.json": JSON.stringify({ types: [], sourceMap: null }),
        "box.luaut": [
            "export default class Box<T>",
            "    value: T",
            "    constructor(value: T)",
            "        this.value = value",
            "    end",
            "    function get(): T",
            "        return this.value",
            "    end",
            "    function map<R>(f: (value: T) -> R): Box<R>",
            "        return new Box(f(this.value))",
            "    end",
            "end",
            "",
        ].join("\n"),
        "main.luaut": [
            `import Box from "./box"`,
            "",
            "class Base",
            "    n = 1",
            "end",
            "class Derived extends Base",
            "end",
            "",
            "const base = new Base()",
            "const derived = new Derived()",
            "print(base.ClassObject == Base, derived.ClassObject == Derived)",
            "print(Derived.ParentClass == Base, Base.ParentClass == nil)",
            "print(derived.ClassObject.ParentClass == Base)",
            "-- The class is one table, shared: nothing of it sits on an instance.",
            "print(rawget(derived, \"ClassObject\") == nil, rawget(derived, \"n\") == 1)",
            "",
            "const numbers = new Box(41)",
            "print(numbers:get() + 1)",
            "print(numbers:map(function(n) return tostring(n) .. \"!\" end):get())",
            "",
            "class Ints extends Box<number>",
            "    constructor(n: number)",
            "        super(n)",
            "    end",
            "    function double(): number",
            "        return this:get() * 2",
            "    end",
            "end",
            "print(new Ints(21):double())",
            "",
            "const Counter = class",
            "    n = 0",
            "    function bump(): number",
            "        this.n += 1",
            "        return this.n",
            "    end",
            "end",
            "const counter = new Counter()",
            "counter:bump()",
            "print(counter:bump(), counter.ClassObject == Counter)",
            "",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.luaut") })
    check("class: the bundle with generics, a class value and a default export type-checks",
        result.diagnostics.map(d => d.message), [])
    runs("class: an instance points at its class, and a class at the one it extends", result, [
        "true\ttrue",
        "true\ttrue",
        "true",
        "true\ttrue",
        "42",
        "41!",
        "42",
        "2\ttrue",
    ])
}

// A class with no accessors anywhere in its chain keeps the plain
// `__index = class` lookup: the metatable is the class table itself.
await lowers("class: the simple case is the plain Lua idiom",
    [
        "class Counter",
        "    n = 0",
        "    function bump(): number",
        "        this.n += 1",
        "        return this.n",
        "    end",
        "end",
    ].join("\n"),
    "local function luaut_class(base) local class = { __getters = {}, __setters = {} }; class.__index = class; "
    + "class.ClassObject = class; class.ParentClass = base; "
    + "if base ~= nil then setmetatable(class, { __index = base }); setmetatable(class.__getters, { __index = base.__getters }); "
    + "setmetatable(class.__setters, { __index = base.__setters }); end; return class; end; "
    + "local function luaut_accessors(class) "
    + "if not class.__dynamic and next(class.__getters) == nil and next(class.__setters) == nil then return; end; "
    + "class.__dynamic = true; "
    + "class.__index = function(this, key) local getter = class.__getters[key]; if getter ~= nil then return getter(this); end; return class[key]; end; "
    + "class.__newindex = function(this, key, value) local setter = class.__setters[key]; if setter ~= nil then setter(this, value); return; end; rawset(this, key, value); end; "
    + "end; "
    + "local Counter = luaut_class(nil); "
    + "function Counter.bump(this) this.n += 1; return this.n; end; "
    + "function Counter.__init(this, ...) this.n = 0; end; "
    + "function Counter.new(...) local this = setmetatable({}, Counter); Counter.__init(this, ...); return this; end; "
    + "luaut_accessors(Counter);")

// `new` is the class's own `new`, and nothing more.
await lowers("class: new is a call of the class's own constructor",
    [
        "declare class Vec { x: number }",
        "declare Vec: { new: (x: number) -> Vec }",
        "const v = new Vec(1)",
    ].join("\n"),
    "local v = Vec.new(1);")

for (const failure of failures) console.log(`FAIL ${failure}`)
const note = luauBinary ? "" : ` (${skipped} runs skipped: no Luau interpreter; set LUAU to run them)`
console.log(`\n${passed} passed, ${failures.length} failed${note}`)
process.exit(failures.length ? 1 : 0)
