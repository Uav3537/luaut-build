// luaut -> Luau. The luaut-parser AST is lowered to a luau-parser AST, which
// luau-parser prints; a project's modules are bundled into one file.
export { bundle, type BundleOptions, type BundleResult, type BundleDiagnostic } from "./bundle.js"
export { compile, type CompileResult, type Diagnostic } from "./compile.js"
export { resolveConfig, type ConfigInput, type LuautConfigJson, type ResolvedConfig } from "./config.js"
export { lower, type LowerOptions, type LowerResult, type LowerDiagnostic, type ModuleContext } from "./lower.js"
