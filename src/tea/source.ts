/**
 * Public facade for source-test planning and artifact generation. The planner
 * lives in sourcePlanner.ts, the pure-expression interpreter in
 * sourceInterpreter.ts, and rendering in sourceRender.ts.
 */
export { planSourceTests } from "./sourcePlanner.js";
export { generateSourceTestArtifacts } from "./sourceRender.js";
