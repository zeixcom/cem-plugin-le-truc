# @zeix/cem-plugin-le-truc

A [`@custom-elements-manifest/analyzer`](https://github.com/open-wc/custom-elements-manifest) plugin that generates standards-compliant `custom-elements.json` manifests for components built with [`@zeix/le-truc`](https://github.com/zeixcom/le-truc).

Le Truc uses a factory pattern (`defineComponent<Props>(tagName, factory)`) rather than class declarations. This plugin bridges the gap so the full CEM ecosystem (editor LSP, AI coding agents, design system tooling) works out of the box.

The plugin runs within `@custom-elements-manifest/analyzer` (`cem analyze`) and **does not require [`@pwrs/cem`](https://github.com/bennypowers/cem)**. The two packages are complementary, not competing — see [Complementary tooling](#complementary-tooling-pwrscem) below.

## Installation

```sh
bun add -D @zeix/cem-plugin-le-truc
```

## Usage

Add to `custom-elements-manifest.config.mjs`:

```js
import { leTrucPlugin } from '@zeix/cem-plugin-le-truc'
import ts from 'typescript'

let typeChecker

export default {
  globs: ['src/**/*.ts'],
  exclude: ['**/*.test.ts'],
  overrideModuleCreation({ ts, globs }) {
    const program = ts.createProgram(globs, { strict: true })
    typeChecker = program.getTypeChecker()
    return program.getSourceFiles().filter(sf => !sf.isDeclarationFile)
  },
  plugins: [leTrucPlugin(() => typeChecker)],
}
```

Run the analyzer:

```sh
npx cem analyze
```

This generates `custom-elements.json` from your Le Truc components.

## What gets extracted

| CEM field | Source |
|---|---|
| `tagName` | First argument of `defineComponent(tagName, …)` |
| `name` | PascalCase from `tagName` (`basic-counter` → `BasicCounter`) |
| `description` | JSDoc above the `export default defineComponent(…)` |
| `members` | Properties of the `Props` type argument via TypeScript type checker |
| `attributes` | Properties in `expose({})` whose initializer is an `as*` call from `@zeix/le-truc` (imported by name or relative path) |
| `slots`, `events`, `cssParts`, `cssProperties` | `@slot`, `@fires`, `@csspart`, `@cssprop` JSDoc tags |
| `demos` | `@demo {url} description` JSDoc tags |

The plugin also fixes up two schema-compliance gaps in the default analyzer's output: it links the default `export` to the synthesised declaration `name` (required by `Reference.name`), and adds `package: "global:"` to built-in `superclass` references (e.g. `HTMLElement` stubs).

## JSDoc contract

```typescript
/**
 * A counter that increments on click. Use it for demonstrating reactive
 * property updates. The host element should contain a `<button>` and a
 * `<span>`; the value must be a non-negative integer.
 * @slot - Default slot for button label
 * @fires count-changed - Fired when the count changes
 * @csspart counter - The counter container
 * @cssprop --counter-color - Text color
 * @demo {./examples/basic-counter.html} Interactive counter demo
 */
export default defineComponent<CounterProps>('basic-counter', ({ expose }) => {
  expose({ count: asInteger() })
  return []
})
```

Property descriptions go on the `Props` type:

```typescript
export type CounterProps = {
  /** Current count value. Read from the `count` attribute at connect time. */
  count: number
}
```

### Description quality

The `description` is free-form JSDoc, but a few conventions improve the manifest's usefulness across the CEM ecosystem — and score well in documentation-health tools like [`cem health`](https://github.com/bennypowers/cem):

- **Explain purpose and context.** Use words like *use*, *for*, *when*, *provides* to describe what the component is for, not just what it is.
- **State constraints with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords.** Words like *must*, *should*, *avoid* clarify requirements (e.g. "the `value` must be a non-negative integer").
- **Mention accessibility.** If the component provides ARIA semantics, keyboard interaction, or screen-reader support, note it.
- **Mention keyboard interaction.** If the component handles keyboard events (Enter, Space, Arrow keys, focus management), document it.

These are recommendations, not requirements — a clear one-liner is better than keyword-stuffed prose.

### `@demo` annotations

```typescript
/**
 * @demo {./examples/basic-counter.html} Interactive counter demo
 * @demo {https://myapp.com/demos/counter} Hosted production demo
 */
```

The URL in braces identifies the demo page; the trailing text is a markdown description. A demo with both a URL and a description scores full marks in `cem health`. The URL may be relative (published with the package) or absolute (hosted).

## Complementary tooling (`@pwrs/cem`)

This plugin generates `custom-elements.json` via `@custom-elements-manifest/analyzer` (`cem analyze`). For additional tooling — consuming the manifest rather than generating it — install [`@pwrs/cem`](https://github.com/bennypowers/cem) globally:

```sh
bun add -g @pwrs/cem
```

`@pwrs/cem` provides tools that read the generated manifest:

| Command | Purpose |
|---|---|
| `cem validate` | Validate `custom-elements.json` against the CEM schema |
| `cem health` | Score documentation quality (descriptions, attributes, demos, etc.) |
| `cem lsp` | Language Server for editor autocomplete, hover docs, and diagnostics |
| `cem mcp` | MCP server for AI coding agents (Claude Code, etc.) |
| `cem list` | Query the manifest (tags, attributes, slots, events, etc.) |
| `cem serve` | Development server with live reload for component demos |

> **Note:** `@pwrs/cem` and `@custom-elements-manifest/analyzer` both provide a `cem` CLI but share no overlapping commands. The analyzer provides `cem analyze` (generation); `@pwrs/cem` provides `validate`, `lsp`, `mcp`, `serve`, etc. (consumption). They are complementary — `bun run` resolves the local analyzer for `cem analyze`, while bare `cem <command>` resolves the global `@pwrs/cem`.
