/**
 * One luaut file -> Luau, on its own: no imports, no exports. A project goes
 * through `bundle` instead.
 */
import { parse, analyzeScopes, analyzeTypes, ParseError, LexError } from "luaut-parser"
import { print } from "luau-parser"
import { lower } from "./lower.js"
import * as luau from "./luau.js"

export interface Diagnostic {
    readonly message: string
    readonly line: number
    readonly column: number
}

export interface CompileResult {
    /** The Luau source, or `undefined` when the file has errors. */
    readonly code?: string
    readonly diagnostics: Diagnostic[]
}

export function compile(source: string): CompileResult {
    let program
    try {
        program = parse(source)
    } catch (error) {
        if (error instanceof ParseError || error instanceof LexError) {
            const { line, column } = error as unknown as { line: number; column: number }
            return { diagnostics: [{ message: (error as Error).message, line, column }] }
        }
        throw error
    }

    // Reassigning a `const` is an error in luaut; Luau would run it anyway.
    const scopes = analyzeScopes(program)
    const diagnostics: Diagnostic[] = scopes.diagnostics.map(d => ({
        message: d.message, line: d.node.line.start, column: d.node.column.start,
    }))

    const lowered = lower(program, scopes, { types: analyzeTypes(program, scopes, { diagnostics: false }) })
    diagnostics.push(...lowered.diagnostics)
    if (diagnostics.length) return { diagnostics }
    return { code: print(luau.program(lowered.statements)) + "\n", diagnostics }
}
