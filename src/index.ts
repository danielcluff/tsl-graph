// Framework-free core: graph model, node registry, commands, TSL compiler,
// templates and importers. Safe to use in Node and the browser.
export * from "./core/types";
export { PROVIDER_IDS, type GraphHost, type McpMode, type ProjectSource, type ProjectStore, type ProviderId } from "./host";
export { createProject, normalizeDoc, nodeCount } from "./core/graph";
export { compileProject } from "./core/codegen";
export { executeCommand, isReadOnly, listNodeTypes, describeNodeType, type Command } from "./core/commands";
export { TEMPLATES, projectFromTemplate } from "./core/templates";
export { importTslGraph, isTslGraphExport, summarizeImport } from "./core/import-tslgraph";
