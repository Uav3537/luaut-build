#!/usr/bin/env node
/**
 *   luaut-build <entry> [--out <file>] [--config <luaut.config.json>] [--noCheck]
 *
 * Bundles `entry` and every module it imports into one Luau file — by default
 * the entry's path with `.luau` — and reports problems as
 * `file:line:column message`. Exits with 1 when there were errors; type errors
 * still produce the bundle.
 */
import { writeFileSync } from "node:fs"
import { relative } from "node:path"
import { bundle } from "./bundle.js"

const usage = "usage: luaut-build <entry> [--out <file>] [--config <luaut.config.json>] [--noCheck]"
const args = process.argv.slice(2)
let entry: string | undefined
let out: string | undefined
let config: string | undefined
let typeCheck = true
for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--out") out = args[++i]
    else if (arg === "--config") config = args[++i]
    else if (arg === "--noCheck") typeCheck = false
    else if (arg === "--help" || arg === "-h") {
        console.log(usage)
        process.exit(0)
    } else entry = arg
}
if (!entry) {
    console.error(usage)
    process.exit(2)
}

const result = await bundle({ entry, config, typeCheck })
for (const d of result.diagnostics) {
    console.error(`${relative(process.cwd(), d.file)}:${d.line}:${d.column} ${d.message}`)
}
if (result.code === undefined) {
    console.error("no bundle written")
    process.exit(1)
}
const target = out ?? entry.replace(/\.luaut$/, "") + ".luau"
writeFileSync(target, result.code)
console.log(`${target}: ${result.modules.length} module${result.modules.length === 1 ? "" : "s"}`)
process.exit(result.diagnostics.length ? 1 : 0)
