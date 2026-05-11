# @zeix/cem-plugin-le-truc

A [`@custom-elements-manifest/analyzer`](https://github.com/open-wc/custom-elements-manifest) plugin that generates standards-compliant `custom-elements.json` manifests for components built with [`@zeix/le-truc`](https://github.com/zeixcom/le-truc).

Le Truc uses a factory pattern (`defineComponent<Props>(tagName, factory)`) rather than class declarations. This plugin bridges the gap so the full CEM ecosystem (editor LSP, AI coding agents, design system tooling) works out of the box.

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

## What gets extracted

| CEM field | Source |
|---|---|
| `tagName` | First argument of `defineComponent(tagName, …)` |
| `name` | PascalCase from `tagName` (`basic-counter` → `BasicCounter`) |
| `description` | JSDoc above the `export default defineComponent(…)` |
| `members` | Properties of the `Props` type argument via TypeScript type checker |
| `attributes` | Properties in `expose({})` whose initializer is an `as*` call from `@zeix/le-truc` |
| `slots`, `events`, `cssParts`, `cssProperties` | `@slot`, `@fires`, `@csspart`, `@cssprop` JSDoc tags |

## JSDoc contract

```typescript
/**
 * A counter that increments on click.
 * @slot - Default slot for button label
 * @fires count-changed - Fired when the count changes
 * @csspart counter - The counter container
 * @cssprop --counter-color - Text color
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
