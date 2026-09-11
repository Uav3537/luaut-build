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
function lowers(name: string, source: string, expected: string): void {
    const result = compile(source)
    if (result.code === undefined) {
        failures.push(`${name}\n    did not compile: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    check(name, flat(result.code), expected)
}

// --- declarations ---------------------------------------------------------------
lowers("const and let are local", "const a = 1\nlet b, c = 2, 3", "local a = 1; local b, c = 2, 3;")
lowers("a declaration without a value", "let x", "local x;")
lowers("types are dropped", "type P = { x: number }\ndeclare game: unknown\nconst n: number = 1 as number", "local n = 1;")
lowers("satisfies and as const are dropped", "const t = { a: 1 } satisfies { a: number }\nconst u = [1] as const", "local t = { a = 1 }; local u = { 1 };")

// --- object destructuring --------------------------------------------------------
lowers("reads straight from a name", "const { a, b } = value", "local a, b = value.a, value.b;")
lowers("renames", "const { a: x, b: y } = value", "local x, y = value.a, value.b;")
lowers("anything but a name is evaluated once",
    "const { a, b } = load()", "local ref = load(); local a, b = ref.a, ref.b;")
lowers("defaults apply to nil",
    "const { a = 1 } = value", "local a = value.a; if a == nil then a = 1; end;")
lowers("nested patterns keep their place in the read",
    "const { a, b: { c }, d } = value", "local a, ref, d = value.a, value.b, value.d; local c = ref.c;")
lowers("a string key that is not a name",
    `const { "has-dash": dash } = value`, `local dash = value["has-dash"];`)
lowers("a computed key is evaluated first",
    "const { [key()]: v } = value", "local key2 = key(); local v = value[key2];")
lowers("rest takes the other keys",
    "const { a, ...others } = value",
    `local a = value.a; local others = {}; for key, value2 in pairs(value) do if key ~= "a" then others[key] = value2; end; end;`)
lowers("destructuring beside plain names",
    "const x, { y } = f()", "local x, ref = f(); local y = ref.y;")

// --- array destructuring ---------------------------------------------------------
lowers("arrays read by index", "const [first, second] = list", "local first, second = list[1], list[2];")
lowers("holes are skipped", "const [, second] = list", "local second = list[2];")
lowers("array rest", "const [head, ...tail] = list", "local head = list[1]; local tail = table.move(list, 2, #list, 1, {});")

// --- destructuring assignment ----------------------------------------------------
lowers("assigns straight from a name", "let a, b = 1, 2\n{ a, b } = value", "local a, b = 1, 2; a, b = value.a, value.b;")
lowers("assignment from anything else is scoped",
    "let a, b = 1, 2\n{ a, b } = { a: b, b: a }", "local a, b = 1, 2; do local ref = { a = b, b = a }; a, b = ref.a, ref.b; end;")

// --- tables, arrays and strings --------------------------------------------------
lowers("object literals", `const t = { a: 1, "b-c": 2, [k]: 3, d }`, `local t = { a = 1, ["b-c"] = 2, [k] = 3, d = d };`)
lowers("array literals are tables", "const xs = [1, 2, 3]", "local xs = { 1, 2, 3 };")
lowers("object spread copies in order",
    "const t = { a: 1, ...base, b: 2 }",
    `local function luaut_assign(target, ...) for i = 1, select("#", ...) do local source = select(i, ...); if source ~= nil then for key, value in pairs(source) do target[key] = value; end; end; end; return target; end; local t = luaut_assign({}, { a = 1 }, base, { b = 2 });`)
lowers("array spread joins the runs",
    "const xs = [f(), ...ys, g()]",
    `local function luaut_concat(...) local result = {}; for i = 1, select("#", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; return result; end; local xs = luaut_concat({ (f()) }, ys, { (g()) });`)
lowers("interpolation becomes format", "print(`${a} any`)", `print(("%s any"):format(tostring(a)));`)
lowers("interpolation escapes percent signs and keeps braces",
    "print(`${n}% of {total}`)", `print(("%s%% of {total}"):format(tostring(n)));`)
lowers("a template without interpolation is a string", "print(`plain`)", `print("plain");`)

// --- functions -------------------------------------------------------------------
lowers("const function is a local function", "const function f(a: number): number\n    return a\nend", "local function f(a) return a; end;")
lowers("parameter defaults", "const function f(a = 1)\nend", "local function f(a) if a == nil then a = 1; end; end;")
lowers("destructured parameters",
    "const function f({ x, y }, [z])\nend", "local function f(arg, arg2) local x, y = arg.x, arg.y; local z = arg2[1]; end;")
lowers("methods keep ':' and drop the injected self",
    "holder = {}\nfunction holder:go(n: number)\n    return self\nend", "holder = {}; function holder:go(n) return self; end;")
lowers("function expressions", "const f = function(a = 2) return a end", "local f = function(a) if a == nil then a = 2; end; return a; end;")

// --- statements and names --------------------------------------------------------
lowers("for-in patterns", "for _, { name } in pairs(t) do\n    print(name)\nend", "for _, item in pairs(t) do local name = item.name; print(name); end;")
lowers("if expressions", "const v = if a then 1 elseif b then 2 else 3", "local v = if a then 1 elseif b then 2 else 3;")
lowers("a Luau keyword used as a name", "let local = 1\nprint(t.local, local)", `local local_ = 1; print(t["local"], local_);`)
lowers("generated names avoid the source's", "const ref = 1\nconst { a } = f()", "local ref = 1; local ref2 = f(); local a = ref2.a;")

lowers("for x in a table yields the values", "const list = [1, 2]\nfor v in list do print(v) end",
    "local list = { 1, 2 }; for _, v in list do print(v); end;")
lowers("an iterator function keeps its own values", "for k in pairs(t) do print(k) end", "for k in pairs(t) do print(k); end;")
lowers("attributes are kept", "@native\nconst function f(x: number): number\n    return x\nend", "@native local function f(x) return x; end;")
lowers("a shadowed global the output needs is captured first",
    "const table = {}\nconst [a, ...rest] = list\nprint(`${a}`)",
    `local luaut_table = table; local table = {}; local a = list[1]; local rest = luaut_table.move(list, 2, #list, 1, {}); print(("%s"):format(tostring(a)));`)

check("a parse error leaves no output",
    ((r) => [r.code, r.diagnostics.length > 0])(compile("const = 1")), [undefined, true])
check("reassigning a const is an error",
    compile("const a = 1\na = 2").diagnostics.map(d => d.message), ["Cannot assign to 'a' — it is a const"])
check("modules need a bundle",
    compile(`import { a } from "./m"`).diagnostics.map(d => d.message), ["Imports and exports need a bundle: build the project with luaut-build"])

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

{
    const root = project({
        "luaut.config.json": JSON.stringify({ types: [], paths: { "@/*": ["src/*"] }, sourceMap: null }),
        "src/main.luaut": `import { twice } from "./math"\nimport { NAME } from "@/names"\nprint(twice(21), NAME)\n`,
        "src/math.luaut": "export const function twice(n: number): number\n    return n * 2\nend\n",
        "src/names.luaut": `export const NAME = "luaut"\n`,
    })
    const result = bundle({ entry: join(root, "src/main.luaut") })
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
            `export const function a1(): string return "a1" end`,
            `export const function hoisted(): string return "hoisted" end`,
            `export const function bump() counter += 1 end`,
            `export const late = "late"`,
            `print("a sees", readLate())`,
        ].join("\n"),
        "b.luaut": [
            `import { hoisted, late } from "./a"`,
            `print("b during the cycle", hoisted(), late)`,
            `export const function readLate(): string return late end`,
        ].join("\n"),
    })
    runs("bundle: a cycle sees hoisted functions at once, and later values live",
        bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        ["b during the cycle\thoisted\tnil", "a sees\tlate", "main\ta1", "counter\t2"])
}

{
    const root = project({
        "main.luaut": `import def, { x as y } from "./m"\nimport { all } from "./re"\nprint(def.v, y, all)\n`,
        "m.luaut": `export const x = "x"\nexport default { v: "default" }\n`,
        "re.luaut": `export * from "./m"\nexport { x as all } from "./m"\n`,
    })
    runs("bundle: default, renamed and re-exported names",
        bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["default\tx\tx"])
}

{
    const root = project({
        "main.luaut": `import { Shape } from "./types"\nimport { value } from "./values"\nconst s: Shape = { r: value }\nprint(s.r)\n`,
        "types.luaut": "export type Shape = { r: number }\n",
        "values.luaut": "export const value = 3\n",
    })
    const result = bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a module imported only for types is left out", result.modules, ["main", "values"])
    runs("bundle: and the rest still runs", result, ["3"])
}

{
    const root = project({ "main.luaut": `export const answer = 42\n` })
    const result = bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: an entry that exports returns its exports", flat(result.code ?? "").endsWith(`return G.require("main");`), true)
}

{
    const root = project({ "main.luaut": `import { nope } from "./missing"\nprint(nope)\n` })
    const result = bundle({ entry: join(root, "main.luaut"), config: { types: [] } })
    check("bundle: a module that cannot be found leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["module", "Cannot find module './missing'"]]])
}

{
    const root = project({ "main.luaut": `const n: number = "text"\nprint(n)\n` })
    const result = bundle({ entry: join(root, "main.luaut"), config: { types: ["./defs.d.luaut"] } })
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
            `const function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number`,
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
        bundle({ entry: join(root, "main.luaut"), config: { types: [] } }),
        ["1 2 2 one three 2 18 big 1 21 100%\tshadows the global"])
}

{
    const root = project({ "main.luaut": `const G = 1\nprint(G)\n` })
    runs("bundle: the module table avoids the modules' names",
        bundle({ entry: join(root, "main.luaut"), config: { types: [] } }), ["1"])
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
