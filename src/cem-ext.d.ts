// @custom-elements-manifest/analyzer exports `create` and `ts` at runtime (index.js)
// but its index.d.ts only declares plugin/config types. Add the missing exports here.
import type {} from "@custom-elements-manifest/analyzer";

declare module "@custom-elements-manifest/analyzer" {
  export function create(opts: {
    // biome-ignore lint/suspicious/noExplicitAny: avoid SyntaxKind enum conflicts
    modules: any[];
    // biome-ignore lint/suspicious/noExplicitAny: avoid SyntaxKind enum conflicts
    plugins?: any[];
    context?: Record<string, unknown>;
    // biome-ignore lint/suspicious/noExplicitAny: avoid SyntaxKind enum conflicts
  }): any;
  // Typed as `any` to avoid SyntaxKind enum conflicts with CEM's bundled TypeScript
  // biome-ignore lint/suspicious/noExplicitAny: avoid SyntaxKind enum conflicts
  export const ts: any;
}
