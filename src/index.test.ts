import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, ts } from "@custom-elements-manifest/analyzer";
import type {
  ClassDeclaration,
  ClassField,
  ClassMethod,
  CustomElement,
  Declaration,
  Package,
} from "custom-elements-manifest/schema";
import { leTrucPlugin } from "./index.ts";

// The plugin produces class declarations augmented with custom-element-specific fields
type PluginDeclaration = ClassDeclaration & CustomElement;

function isCustomElementDeclaration(d: Declaration): d is PluginDeclaration {
  return d.kind === "class" && "customElement" in d && d.customElement === true;
}

// Run the plugin without a type checker.
// The analyzer's index.d.ts doesn't declare `create` (only the Plugin
// interfaces), so its return type is `any` — assert the documented shape once
// here so every test works with a typed Package.
function runPlugin(sources: Record<string, string>): Package {
  const modules = Object.entries(sources).map(([fn, src]) =>
    ts.createSourceFile(fn, src, ts.ScriptTarget.ESNext, true),
  );
  return create({ modules, plugins: [leTrucPlugin()] }) as Package;
}

// Run the plugin with a type checker
function runPluginWithTypeChecker(sources: Record<string, string>): Package {
  const host = ts.createCompilerHost({});
  host.getSourceFile = (fn: string, langVer: number) => {
    if (fn in sources)
      // biome-ignore lint/style/noNonNullAssertion: test
      return ts.createSourceFile(fn, sources[fn]!, langVer, true);
    return undefined;
  };
  host.fileExists = (fn: string) => fn in sources;
  host.readFile = (fn: string) => sources[fn];
  host.writeFile = () => {};
  host.getCurrentDirectory = () => "/";
  host.getDefaultLibFileName = () => "lib.d.ts";
  host.getDirectories = () => [];
  host.directoryExists = () => true;

  const program = ts.createProgram({
    rootNames: Object.keys(sources),
    options: { target: ts.ScriptTarget.ESNext, strict: false, noLib: true },
    host,
  });

  const typeChecker = program.getTypeChecker();
  const modules = Object.keys(sources)
    .map((fn) => program.getSourceFile(fn))
    .filter((sf): sf is NonNullable<typeof sf> => sf != null);

  return create({ modules, plugins: [leTrucPlugin(() => typeChecker)] }) as Package;
}

// Every test manifest contains exactly one Le Truc component, so a missing
// declaration is a test failure, not a case to type around — throw instead of
// returning undefined to keep call sites free of null-guards.
function getDeclaration(manifest: Package): PluginDeclaration {
  const decl = manifest.modules
    .flatMap((m) => m.declarations ?? [])
    .find(isCustomElementDeclaration);
  if (!decl) throw new Error("manifest has no custom-element declaration");
  return decl;
}

// ─── Test 1: Basic component ───────────────────────────────────────────────

describe("defineComponent detection", () => {
  const src = {
    "counter.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
export type CounterProps = { count: number }
export default defineComponent<CounterProps>('basic-counter', () => [])
`,
  };

  test("extracts tagName", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).tagName).toBe("basic-counter");
  });

  test("derives PascalCase name", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).name).toBe("BasicCounter");
  });

  test("pushes a custom-element-definition export", () => {
    const manifest = runPlugin(src);
    // biome-ignore lint/style/noNonNullAssertion: test
    const mod = manifest.modules[0]!;
    const exp = (mod.exports ?? []).find(
      (e) => e.kind === "custom-element-definition",
    );
    expect(exp?.name).toBe("basic-counter");
    expect(exp?.declaration.name).toBe("BasicCounter");
  });

  test("links the default js export to the synthesised declaration name", () => {
    // The default analyzer emits {kind:'js', name:'default', declaration:{module}}
    // for `export default defineComponent(...)` but omits declaration.name (it
    // can't resolve the call expression's return type). The CEM schema requires
    // Reference.name, so the plugin must patch the default export. This is a
    // regression test for the "missing property 'name'" cem validate failure.
    const manifest = runPlugin(src);
    // biome-ignore lint/style/noNonNullAssertion: test
    const mod = manifest.modules[0]!;
    const defaultExp = (mod.exports ?? []).find(
      (e) => e.kind === "js" && e.name === "default",
    );
    expect(defaultExp?.declaration?.name).toBe("BasicCounter");
  });

  test("extracts JSDoc description", () => {
    const manifest = runPlugin({
      "el.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/** A friendly greeting element. */
export default defineComponent<{}>('basic-hello', () => [])
`,
    });
    expect(getDeclaration(manifest).description).toBe(
      "A friendly greeting element.",
    );
  });
});

// ─── Test 2: Props type resolution ─────────────────────────────────────────

describe("Props member resolution via type checker", () => {
  const src = {
    "typed.ts": `
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type TypedProps = {
  /** The current count value. */
  count: number
  label: string
}

export default defineComponent<TypedProps>('typed-el', () => [])
`,
  };

  const findField = (decl: PluginDeclaration, name: string) =>
    (decl.members ?? []).find(
      (m): m is ClassField => m.kind === "field" && m.name === name,
    );

  test("builds members from Props type", () => {
    const manifest = runPluginWithTypeChecker(src);
    expect(getDeclaration(manifest).members).toHaveLength(2);
  });

  test("sets field name and type", () => {
    const manifest = runPluginWithTypeChecker(src);
    const countField = findField(getDeclaration(manifest), "count");
    expect(countField?.kind).toBe("field");
    expect(countField?.type?.text).toBe("number");
  });

  test("includes JSDoc description from Props property", () => {
    const manifest = runPluginWithTypeChecker(src);
    const countField = findField(getDeclaration(manifest), "count");
    expect(countField?.description).toBe("The current count value.");
  });

  test("members are absent (not populated) without type checker", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).members ?? []).toHaveLength(0);
  });
});

describe("Props member resolution: function-typed props are methods", () => {
  const findMethod = (decl: PluginDeclaration, name: string) =>
    (decl.members ?? []).find(
      (m): m is ClassMethod => m.kind === "method" && m.name === name,
    );

  test("a `() => void` prop is a method, not a field with a function type", () => {
    const manifest = runPluginWithTypeChecker({
      "form-textbox.ts": `
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type FormTextboxProps = {
  value: string
  /** Clears the input value. */
  clear: () => void
}

export default defineComponent<FormTextboxProps>('form-textbox', () => [])
`,
    });
    const decl = getDeclaration(manifest);
    const clearMethod = findMethod(decl, "clear");
    expect(clearMethod).toBeDefined();
    expect(clearMethod?.kind).toBe("method");
    expect(clearMethod?.return?.type?.text).toBe("void");
    expect(clearMethod?.description).toBe("Clears the input value.");
    // Not also emitted as a field
    expect(
      (decl.members ?? []).filter((m) => m.name === "clear"),
    ).toHaveLength(1);
  });

  test("parameters and non-void return type are captured", () => {
    const manifest = runPluginWithTypeChecker({
      "form-spinbutton.ts": `
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type FormSpinbuttonProps = {
  value: number
  stepUp: (steps?: number) => boolean
}

export default defineComponent<FormSpinbuttonProps>('form-spinbutton', () => [])
`,
    });
    const decl = getDeclaration(manifest);
    const stepUp = findMethod(decl, "stepUp");
    expect(stepUp?.return?.type?.text).toBe("boolean");
    expect(stepUp?.parameters).toHaveLength(1);
    expect(stepUp?.parameters?.[0]).toMatchObject({
      name: "steps",
      optional: true,
    });
  });

  test("a plain data field is still a field", () => {
    const manifest = runPluginWithTypeChecker({
      "typed.ts": `
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type TypedProps = {
  count: number
}

export default defineComponent<TypedProps>('typed-el', () => [])
`,
    });
    const decl = getDeclaration(manifest);
    expect(decl.members?.find((m) => m.name === "count")?.kind).toBe("field");
  });
});

// ─── Test 3: JSDoc tag extraction ──────────────────────────────────────────

describe("JSDoc tag extraction", () => {
  const src = {
    "tagged.ts": `
declare function defineComponent<P>(tag: string, factory: any): any

/**
 * A richly annotated element.
 * @slot - Default slot for content
 * @slot header - Header slot
 * @fires change - Fired when value changes
 * @csspart container - The outer container
 * @cssprop --tag-color - The accent color
 */
export default defineComponent<{}>('tagged-el', () => [])
`,
  };

  test("extracts @slot tags (named and anonymous)", () => {
    const manifest = runPlugin(src);
    const slots = getDeclaration(manifest).slots ?? [];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      name: "",
      description: "Default slot for content",
    });
    expect(slots[1]).toMatchObject({
      name: "header",
      description: "Header slot",
    });
  });

  test("extracts @fires tags", () => {
    const manifest = runPlugin(src);
    const events = getDeclaration(manifest).events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "change",
      type: { text: "CustomEvent" },
      description: "Fired when value changes",
    });
  });

  test("extracts @csspart tags", () => {
    const manifest = runPlugin(src);
    const cssParts = getDeclaration(manifest).cssParts ?? [];
    expect(cssParts).toHaveLength(1);
    expect(cssParts[0]).toMatchObject({
      name: "container",
      description: "The outer container",
    });
  });

  test("extracts @cssprop tags", () => {
    const manifest = runPlugin(src);
    const cssProperties = getDeclaration(manifest).cssProperties ?? [];
    expect(cssProperties).toHaveLength(1);
    expect(cssProperties[0]).toMatchObject({
      name: "--tag-color",
      description: "The accent color",
    });
  });

  test("extracts @demo tags with URL and description", () => {
    const manifest = runPlugin({
      "demo-el.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * A demoable element.
 * @demo {./examples/demo-el.html} Interactive demo showing all states
 */
export default defineComponent<{}>('demo-el', () => [])
`,
    });
    const demos = getDeclaration(manifest).demos ?? [];
    expect(demos).toHaveLength(1);
    expect(demos[0]).toMatchObject({
      url: "./examples/demo-el.html",
      description: "Interactive demo showing all states",
    });
  });

  test("extracts @demo tag with URL only (no description)", () => {
    const manifest = runPlugin({
      "demo-el2.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * @demo {https://example.com/demo.html}
 */
export default defineComponent<{}>('demo-el2', () => [])
`,
    });
    const demos = getDeclaration(manifest).demos ?? [];
    expect(demos).toHaveLength(1);
    expect(demos[0]).toMatchObject({
      url: "https://example.com/demo.html",
    });
    expect(demos[0]?.description).toBeUndefined();
  });
});

// ─── Test 3b: @attribute / @attr tags (connect-time attributes) ─────────────
// Attributes read via host.getAttribute() at connect time but never exposed as
// reactive properties. Declared in JSDoc; emitted WITHOUT fieldName.

describe("@attribute / @attr JSDoc tags", () => {
  test("extracts @attribute with type and description, no fieldName", () => {
    const manifest = runPlugin({
      "attr-el.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * A configurable element.
 * @attribute {'horizontal'|'vertical'} orientation - Layout direction. Read once at connect time.
 */
export default defineComponent<{}>('attr-el', () => [])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({
      name: "orientation",
      type: { text: "'horizontal'|'vertical'" },
      description: "Layout direction. Read once at connect time.",
    });
    expect(attributes[0]?.fieldName).toBeUndefined();
  });

  test("@attr alias produces the identical entry", () => {
    const manifest = runPlugin({
      "attr-alias.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * @attr {string} theme - Color theme name.
 */
export default defineComponent<{}>('attr-alias', () => [])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({
      name: "theme",
      type: { text: "string" },
      description: "Color theme name.",
    });
  });

  test("[name=default] square-bracket form sets default", () => {
    const manifest = runPlugin({
      "attr-default.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * @attribute {number} [split=0.5] - Initial split ratio.
 */
export default defineComponent<{}>('attr-default', () => [])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]).toMatchObject({
      name: "split",
      type: { text: "number" },
      default: "0.5",
      description: "Initial split ratio.",
    });
  });

  test("bare tag with name only", () => {
    const manifest = runPlugin({
      "attr-bare.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * @attribute compact
 */
export default defineComponent<{}>('attr-bare', () => [])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({ name: "compact" });
    expect(attributes[0]?.type).toBeUndefined();
    expect(attributes[0]?.description).toBeUndefined();
  });

  test("tag without a name is ignored", () => {
    const manifest = runPlugin({
      "attr-nameless.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
/**
 * @attribute - dangling description without a name
 */
export default defineComponent<{}>('attr-nameless', () => [])
`,
    });
    expect(getDeclaration(manifest).attributes ?? []).toHaveLength(0);
  });

  test("merges with an expose()-derived attribute of the same name", () => {
    const manifest = runPluginWithTypeChecker({
      "attr-merge.ts": `
import { asInteger } from '@zeix/le-truc'
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type MergeProps = { count: number }

/**
 * @attribute {string} [count=0] - Starting count.
 */
export default defineComponent<MergeProps>('attr-merge', ({ expose }: any) => {
  expose({ count: asInteger() })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    // fieldName and Props-derived type win; JSDoc fills description/default.
    expect(attributes[0]).toMatchObject({
      name: "count",
      fieldName: "count",
      type: { text: "number" },
      default: "0",
      description: "Starting count.",
    });
  });
});

// ─── Test 4: No expose() call ───────────────────────────────────────────────

describe("No expose() — members from Props, attributes empty", () => {
  const src = {
    "no-expose.ts": `
declare function defineComponent<P extends object>(tag: string, factory: any): any

export type NoExposeProps = { value: number }

export default defineComponent<NoExposeProps>('no-expose', () => [])
`,
  };

  test("attributes are absent (not populated) when expose() is absent", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).attributes ?? []).toHaveLength(0);
  });

  test("members are populated from Props type when type checker provided", () => {
    const manifest = runPluginWithTypeChecker(src);
    const members = getDeclaration(manifest).members ?? [];
    expect(members).toHaveLength(1);
    expect(members[0]?.name).toBe("value");
  });
});

// ─── Test 5: HTMLElementTagNameMap augmentation ──────────────────────────

describe("HTMLElementTagNameMap augmentation coexistence", () => {
  const src = {
    "with-tagmap.ts": `
declare function defineComponent<P>(tag: string, factory: any): any

export type MapProps = { count: number }

declare global {
  interface HTMLElementTagNameMap {
    'map-counter': HTMLElement & MapProps
  }
}

export default defineComponent<MapProps>('map-counter', () => [])
`,
  };

  test("produces exactly one custom element declaration", () => {
    const manifest = runPlugin(src);
    const decls = manifest.modules
      .flatMap((m) => m.declarations ?? [])
      .filter(isCustomElementDeclaration);
    expect(decls).toHaveLength(1);
  });

  test("tag name is correct despite augmentation", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).tagName).toBe("map-counter");
  });
});

// ─── Test 6: Parser-backed attributes ──────────────────────────────────────

describe("expose() with as* parsers", () => {
  const parserSrc = {
    "parser-el.ts": `
import { asInteger, asBoolean, asString } from '@zeix/le-truc'

declare function defineComponent<P extends object>(tag: string, factory: any): any

export type ParserProps = { count: number; active: boolean; label: string }

export default defineComponent<ParserProps>('parser-el', ({ expose }: any) => {
  expose({
    count: asInteger(),
    active: asBoolean(),
    label: asString(),
  })
  return []
})
`,
  };

  test("detects as* parser calls from @zeix/le-truc as attributes", () => {
    const manifest = runPlugin(parserSrc);
    expect(getDeclaration(manifest).attributes).toHaveLength(3);
  });

  test("sets name and fieldName on each attribute", () => {
    const manifest = runPlugin(parserSrc);
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]).toMatchObject({
      name: "count",
      fieldName: "count",
    });
    expect(attributes[1]).toMatchObject({
      name: "active",
      fieldName: "active",
    });
    expect(attributes[2]).toMatchObject({
      name: "label",
      fieldName: "label",
    });
  });

  test("copies type from matching member when type checker is provided", () => {
    const manifest = runPluginWithTypeChecker(parserSrc);
    const countAttr = (getDeclaration(manifest).attributes ?? []).find(
      (a) => a.name === "count",
    );
    expect(countAttr?.type?.text).toBe("number");
  });

  test("ignores non-le-truc as* functions", () => {
    const manifest = runPlugin({
      "custom-parser.ts": `
function asCustom() { return 0 }
declare function defineComponent<P>(tag: string, factory: any): any

export default defineComponent<{ x: number }>('custom-el', ({ expose }: any) => {
  expose({ x: asCustom() })
  return []
})
`,
    });
    expect(getDeclaration(manifest).attributes ?? []).toHaveLength(0);
  });
});

describe("expose() with as* parsers: default extraction", () => {
  test("asBoolean() with no args defaults to false", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asBoolean } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ active: boolean }>('bool-el', ({ expose }: any) => {
  expose({ active: asBoolean() })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("false");
  });

  test("asBoolean(true) captures explicit literal default", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asBoolean } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ active: boolean }>('bool-el', ({ expose }: any) => {
  expose({ active: asBoolean(true) })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("true");
  });

  test("asString() with no args defaults to empty string", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asString } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ label: string }>('str-el', ({ expose }: any) => {
  expose({ label: asString() })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe('""');
  });

  test("asString('foo') captures explicit literal default", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asString } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ label: string }>('str-el', ({ expose }: any) => {
  expose({ label: asString('foo') })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe('"foo"');
  });

  test("asNumber()/asInteger() with no args default to 0", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asNumber, asInteger } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ count: number; total: number }>('num-el', ({ expose }: any) => {
  expose({ count: asNumber(), total: asInteger() })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("0");
    expect(attributes[1]?.default).toBe("0");
  });

  test("asNumber(-5) captures negative literal default", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asNumber } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ offset: number }>('num-el', ({ expose }: any) => {
  expose({ offset: asNumber(-5) })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("-5");
  });

  test("asClampedInteger(min, max) defaults to min", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asClampedInteger } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ steps: number }>('clamp-el', ({ expose }: any) => {
  expose({ steps: asClampedInteger(1, 10) })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("1");
  });

  test("asEnum([...]) defaults to first array entry", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asEnum } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{ size: string }>('enum-el', ({ expose }: any) => {
  expose({ size: asEnum(['md', 'sm', 'lg']) })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe('"md"');
  });

  test("non-literal argument falls back to the parser's assumed default", () => {
    const manifest = runPlugin({
      "el.ts": `
import { asBoolean } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any
const FALLBACK = true
export default defineComponent<{ active: boolean }>('bool-el', ({ expose }: any) => {
  expose({ active: asBoolean(FALLBACK) })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes[0]?.default).toBe("false");
  });
});

describe("expose() with asParser()", () => {
  test("detects asParser() call as attribute-backed", () => {
    const manifest = runPlugin({
      "as-parser.ts": `
import { asParser } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any): any

export default defineComponent<{ data: string }>('custom-parser', ({ expose }: any) => {
  expose({ data: asParser(() => '') })
  return []
})
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({
      name: "data",
      fieldName: "data",
    });
  });
});

// ─── Test 6b: Component extensions (le-truc >=2.3) ───────────────────────────
// formAssociated()/formAssociatedCheckbox() install a native-parity host
// contract (form, name, disabled, labels, validity, ...) on the prototype at
// runtime — never visible as class members in the component's own source.
// observedAttributes() re-syncs an already-exposed Parser-backed prop from
// its attribute post-connect.

describe("defineComponent extensions", () => {
  test("formAssociated() adds host-contract members and attributes", () => {
    const manifest = runPlugin({
      "form-input.ts": `
import { formAssociated } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any, extensions?: any): any

export default defineComponent<{ value: string }>('form-input', ({ expose }: any) => {
  expose({ value: '' })
  return []
}, [formAssociated()])
`,
    });
    const decl = getDeclaration(manifest);
    const members = decl.members ?? [];
    const attributes = decl.attributes ?? [];
    for (const name of [
      "form",
      "name",
      "disabled",
      "labels",
      "validity",
      "validationMessage",
      "willValidate",
    ]) {
      expect(members.some((m) => m.name === name)).toBe(true);
    }
    for (const name of ["checkValidity", "reportValidity", "setCustomValidity"]) {
      expect(members.some((m) => m.name === name && m.kind === "method")).toBe(
        true,
      );
    }
    expect(attributes.some((a) => a.name === "name")).toBe(true);
    expect(attributes.some((a) => a.name === "disabled")).toBe(true);
  });

  test("formAssociatedCheckbox() adds the same host-contract members", () => {
    const manifest = runPlugin({
      "form-checkbox.ts": `
import { formAssociatedCheckbox } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any, extensions?: any): any

export default defineComponent<{ checked: boolean }>('form-checkbox', ({ expose }: any) => {
  expose({ checked: false })
  return []
}, [formAssociatedCheckbox()])
`,
    });
    const members = getDeclaration(manifest).members ?? [];
    expect(members.some((m) => m.name === "form")).toBe(true);
    expect(members.some((m) => m.name === "checkValidity")).toBe(true);
  });

  test("non-le-truc formAssociated() identifier is ignored", () => {
    const manifest = runPlugin({
      "custom-ext.ts": `
declare function formAssociated(): any
declare function defineComponent<P>(tag: string, factory: any, extensions?: any): any

export default defineComponent<{ value: string }>('custom-ext', ({ expose }: any) => {
  expose({ value: '' })
  return []
}, [formAssociated()])
`,
    });
    const members = getDeclaration(manifest).members ?? [];
    expect(members.some((m) => m.name === "form")).toBe(false);
  });

  test("observedAttributes() adds attributes not already exposed", () => {
    const manifest = runPlugin({
      "variant-el.ts": `
import { observedAttributes } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any, extensions?: any): any

export default defineComponent<{ variant: string }>('variant-el', () => [], [observedAttributes(['variant'])])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({ name: "variant", fieldName: "variant" });
  });

  test("observedAttributes() fills fieldName on an existing expose()-derived attribute", () => {
    const manifest = runPlugin({
      "variant-el2.ts": `
import { asString } from '@zeix/le-truc'
import { observedAttributes } from '@zeix/le-truc'
declare function defineComponent<P>(tag: string, factory: any, extensions?: any): any

export default defineComponent<{ variant: string }>('variant-el2', ({ expose }: any) => {
  expose({ variant: asString() })
  return []
}, [observedAttributes(['variant'])])
`,
    });
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({ name: "variant", fieldName: "variant" });
  });
});

// ─── Test 7: Relative imports resolving to @zeix/le-truc ─────────────────────
// Covers the self-analysis gap (NOTES.md): le-truc's own examples import via
// '../../..' rather than '@zeix/le-truc'. The plugin resolves the relative
// specifier against the importing file and rewrites it to the owning package
// name, so attribute detection works for monorepo / in-repo consumers too.
describe("Relative imports resolved to package name", () => {
  test("detects as* parsers imported via relative path into the package root", () => {
    // Build a real throwaway package tree on disk so the plugin's filesystem
    // resolution walks up to a package.json named '@zeix/le-truc'.
    const root = mkdtempSync(join(tmpdir(), "cem-rel-"));
    const pkgDir = join(root, "fake-le-truc");
    const examplesDir = join(pkgDir, "examples", "basic", "counter");
    mkdirSync(examplesDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@zeix/le-truc", version: "0.0.0" }),
    );
    writeFileSync(
      join(pkgDir, "index.ts"),
      "export function asInteger() { return (v: string | null) => 0 }\n",
    );
    const counterPath = join(examplesDir, "basic-counter.ts");
    const counterSrc = `import { asInteger } from '../../..'
declare function defineComponent<P>(tag: string, factory: any): any

export default defineComponent<{ count: number }>('basic-counter', ({ expose }: any) => {
  expose({ count: asInteger() })
  return []
})
`;
    writeFileSync(counterPath, counterSrc);
    const modules = [
      ts.createSourceFile(
        counterPath,
        counterSrc,
        ts.ScriptTarget.ESNext,
        true,
      ),
    ];
    const manifest = create({ modules, plugins: [leTrucPlugin()] }) as Package;
    rmSync(root, { recursive: true, force: true });
    // Without resolution, the import map stores '../../..' which never equals
    // '@zeix/le-truc' and attributes stay empty. With resolution, the owning
    // package.json name is used, so the attribute is detected.
    const attributes = getDeclaration(manifest).attributes ?? [];
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({
      name: "count",
      fieldName: "count",
    });
  });
});

// ─── Test 8: module paths are relativized against cwd ───────────────────────
// The overrideModuleCreation boilerplate feeds ts.createProgram source files
// to the analyzer, whose fileNames are absolute — so module.path and every
// Reference.module came out absolute: non-portable (CI runner paths in the
// published manifest) and CEM-schema-non-conformant (paths must be
// package-root-relative). packageLinkPhase now relativizes every
// "path"/"module" string under process.cwd(); paths outside cwd are kept.
describe("packageLinkPhase: module path relativization", () => {
  test("rewrites absolute module.path and Reference.module relative to cwd", () => {
    const absPath = join(process.cwd(), "examples", "abs-el.ts");
    const manifest = runPlugin({
      [absPath]: `
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{}>('abs-el', () => [])
`,
    });
    const mod = manifest.modules[0];
    expect(mod?.path).toBe("examples/abs-el.ts");
    const ceDef = (mod?.exports ?? []).find(
      (e) => e.kind === "custom-element-definition",
    );
    expect(ceDef?.declaration.module).toBe("examples/abs-el.ts");
    const defaultExp = (mod?.exports ?? []).find(
      (e) => e.kind === "js" && e.name === "default",
    );
    expect(defaultExp?.declaration.module).toBe("examples/abs-el.ts");
  });

  test("leaves relative paths and paths outside cwd untouched", () => {
    const outside = join(tmpdir(), "elsewhere", "out-el.ts");
    const manifest = runPlugin({
      "already-relative.ts": `
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{}>('rel-el', () => [])
`,
      [outside]: `
declare function defineComponent<P>(tag: string, factory: any): any
export default defineComponent<{}>('out-el', () => [])
`,
    });
    const paths = manifest.modules.map((m) => m.path);
    expect(paths).toContain("already-relative.ts");
    expect(paths).toContain(outside);
  });
});

// ─── Test 9: superclass package field for built-in types ────────────────────
// The default analyzer emits superclass: { name: "HTMLElement" } without
// `package: "global:"` for declarations it produces (e.g. structural-only
// `class extends HTMLElement {}` stubs). The CEM spec requires built-in types
// to declare package: "global:". Regression test for the cem validate warning
// "superclass HTMLElement is a built-in type but missing package field".
describe("packageLinkPhase: superclass package field", () => {
  test("adds package: global: to built-in superclass references", () => {
    const manifest = runPlugin({
      "stub.ts": `
class StubEl extends HTMLElement {}
customElements.define('stub-el', StubEl)
`,
    });
    // Find the declaration produced by the default analyzer (not our plugin's
    // synthesised one — stub-el has no defineComponent call).
    const stubDecl = manifest.modules
      .flatMap((m) => m.declarations ?? [])
      .find(
        (d): d is ClassDeclaration => d.kind === "class" && d.name === "StubEl",
      );
    expect(stubDecl?.superclass).toMatchObject({
      name: "HTMLElement",
      package: "global:",
    });
  });
});
