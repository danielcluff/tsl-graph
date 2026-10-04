// Framework-free core: graph model, node registry, commands, TSL compiler,
// templates and importers. Safe to use in Node and the browser.
export * from "./core/types";
export { PROVIDER_IDS, type GraphHost, type McpMode, type ProjectSource, type ProjectStore, type ProviderId } from "./host";
/// <reference path="./types.d.ts" />
export { GRAPH_KINDS, createProject, makeNode, normalizeDoc, nodeCount, primaryGraph, projectGraphs, resolvePorts } from "./core/graph";
export { CATEGORY_ORDER, allNodeDefs, getNodeDef } from "./core/registry";
export { compileProject, PARTICLE_INPUTS } from "./core/codegen";
export { executeCommand, isReadOnly, listNodeTypes, describeNodeType, type Command } from "./core/commands";
export { TEMPLATES, projectFromTemplate } from "./core/templates";
export { importTslGraph, isTslGraphExport, summarizeImport } from "./core/import-tslgraph";
