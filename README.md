# luaut-build

Compiles a [luaut](https://www.npmjs.com/package/luaut-parser) project to one
Luau file. Each file is parsed by `luaut-parser`, its AST lowered to a
`luau-parser` AST, and that AST printed by `luau-parser`.

```bash
npm i -D luaut-build
npx luaut-build src/main.luaut --out build/main.luau
```

```
luaut-build <entry> [--out <file>] [--config <luaut.config.json>] [--noCheck]
```

Every module the entry imports is bundled in. Type errors are checked against
the config's `types`: they are reported, but the bundle is still written
(`--noCheck` skips the check). A syntax error or a missing module stops the
build.

## API

```ts
import { bundle } from "luaut-build"

const result = bundle({
    entry: "src/main.luaut",
    // A config file's path, or its contents:
    config: { types: ["roblox"], paths: { "@shared/*": ["src/shared/*"] } },
})
result.code          // the Luau bundle, unless a module failed
result.diagnostics   // { file, line, column, message, category: "syntax" | "module" | "type" | "config" }
```

`config` is typed `string | LuautConfigJson`. Left out, the nearest
`luaut.config.json` above the entry applies.

## What becomes what

| luaut | Luau |
|---|---|
| `const { a, b } = value` | `local a, b = value.a, value.b` |
| `const [x, ...rest] = list` | `local x = list[1]; local rest = table.move(list, 2, #list, 1, {})` |
| `const { a = 1 } = t` | `local a = t.a; if a == nil then a = 1 end` |
| `[1, 2]` / `{ a: 1, b }` | `{ 1, 2 }` / `{ a = 1, b = b }` |
| `{ ...base, a: 1 }` / `[...xs, 1]` | a small helper copying the parts in order |
| `` `${a} any` `` | `("%s any"):format(tostring(a))` |
| `function f(n = 1, { x })` | `function f(n, arg) if n == nil then n = 1 end local x = arg.x ...` |
| `const` / `let` | `local` |
| `x as T`, `x satisfies T`, types, `declare` | removed |

## Modules

Roblox's `require` takes an Instance, so the bundle has its own. Each module
is an entry in one table:

```lua
local G
G = {
    modules = {
        ["src/util"] = {
            names = { clamp = true },
            load = function(exports)
                function exports.clamp(x, lo, hi) ... end
            end,
        },
        ["src/main"] = {
            load = function(exports)
                local util
                util = G.require("src/util")
                print(util.clamp(5, 0, 1))
            end,
        },
    },
    records = {},
    require = function(name) ... end,
}
G.require("src/main")
```

Modules are named by their path from the project folder. An entry that
exports ends with `return G.require(...)`, so the bundle can itself be a
ModuleScript.

Modules follow ES module rules, including when they import each other:

- **Loading state.** A module's record exists, marked `loading`, before its
  code runs. When `a` imports `b` and `b` imports `a` back, `b` gets `a`'s
  exports as they stand instead of loading `a` again.
- **Hoisting.** Every top-level function is defined before a module's imports
  run, so `b` can call `a`'s functions in the middle of that cycle.
- **Initialization.** Reading an export its module has not initialized yet is
  an error — `Cannot access 'x' before initialization` — as reading a `let`
  before its declaration is in JavaScript.
- **Live bindings.** Exports live on the module's `exports` table and imports
  are read through it (`util.clamp`, never a copy), so a value set later — or
  a `let` changed later — is what the importer sees. Re-exports
  (`export { x } from`) and `export *` are references too: they read the
  other module on every access.
- **Read-only imports.** Assigning to an imported name, or to a member of a
  namespace (`import * as M`, then `M.x = 1`), is an error.
- **Types only.** `import type` is erased whatever it names, and so is an
  import used only as a type. A module reached only that way is left out of
  the bundle and never runs.

## Tests

```bash
npm test
```

With a Luau interpreter on the `PATH` (or named by `LUAU`), the tests also run
each bundle and check its output.
