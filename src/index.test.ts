import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, ts } from "@custom-elements-manifest/analyzer";
import { leTrucPlugin } from "./index.ts";

// Run the plugin without a type checker (for LT-002, LT-004, LT-005)
function runPlugin(sources: Record<string, string>) {
  const modules = Object.entries(sources).map(([fn, src]) =>
    ts.createSourceFile(fn, src, ts.ScriptTarget.ESNext, true),
  );
  return create({ modules, plugins: [leTrucPlugin()] });
}

// Run the plugin with a type checker (for LT-003)
function runPluginWithTypeChecker(sources: Record<string, string>) {
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
    // biome-ignore lint/suspicious/noExplicitAny: test
    .filter((sf): sf is typeof ts.Node => sf != null) as any[];

  return create({ modules, plugins: [leTrucPlugin(() => typeChecker)] });
}

// biome-ignore lint/suspicious/noExplicitAny: test
function getDeclaration(manifest: any) {
  return (
    manifest.modules
      // biome-ignore lint/suspicious/noExplicitAny: test
      .flatMap((m: any) => m.declarations ?? [])
      // biome-ignore lint/suspicious/noExplicitAny: test
      .find((d: any) => d.customElement === true) as any
  );
}

// ─── Test 1: Basic component ───────────────────────────────────────────────

describe("LT-002: defineComponent detection", () => {
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
      // biome-ignore lint/suspicious/noExplicitAny: test
      (e: any) => e.kind === "custom-element-definition",
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
    // biome-ignore lint/suspicious/noExplicitAny: test
    const defaultExp = (mod.exports ?? []).find(
      (e: any) => e.kind === "js" && e.name === "default",
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

describe("LT-003: Props member resolution via type checker", () => {
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

  test("builds members from Props type", () => {
    const manifest = runPluginWithTypeChecker(src);
    const decl = getDeclaration(manifest);
    expect(decl.members).toHaveLength(2);
  });

  test("sets field name and type", () => {
    const manifest = runPluginWithTypeChecker(src);
    const decl = getDeclaration(manifest);
    // biome-ignore lint/suspicious/noExplicitAny: test
    const countField = decl.members.find((m: any) => m.name === "count");
    expect(countField.kind).toBe("field");
    expect(countField.type.text).toBe("number");
  });

  test("includes JSDoc description from Props property", () => {
    const manifest = runPluginWithTypeChecker(src);
    const decl = getDeclaration(manifest);
    // biome-ignore lint/suspicious/noExplicitAny: test
    const countField = decl.members.find((m: any) => m.name === "count");
    expect(countField.description).toBe("The current count value.");
  });

  test("members are absent (not populated) without type checker", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).members ?? []).toHaveLength(0);
  });
});

// ─── Test 3: JSDoc tag extraction ──────────────────────────────────────────

describe("LT-005: JSDoc tag extraction", () => {
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
    const decl = getDeclaration(manifest);
    expect(decl.slots).toHaveLength(2);
    expect(decl.slots[0]).toMatchObject({
      name: "",
      description: "Default slot for content",
    });
    expect(decl.slots[1]).toMatchObject({
      name: "header",
      description: "Header slot",
    });
  });

  test("extracts @fires tags", () => {
    const manifest = runPlugin(src);
    const decl = getDeclaration(manifest);
    expect(decl.events).toHaveLength(1);
    expect(decl.events[0]).toMatchObject({
      name: "change",
      type: { text: "CustomEvent" },
      description: "Fired when value changes",
    });
  });

  test("extracts @csspart tags", () => {
    const manifest = runPlugin(src);
    const decl = getDeclaration(manifest);
    expect(decl.cssParts).toHaveLength(1);
    expect(decl.cssParts[0]).toMatchObject({
      name: "container",
      description: "The outer container",
    });
  });

  test("extracts @cssprop tags", () => {
    const manifest = runPlugin(src);
    const decl = getDeclaration(manifest);
    expect(decl.cssProperties).toHaveLength(1);
    expect(decl.cssProperties[0]).toMatchObject({
      name: "--tag-color",
      description: "The accent color",
    });
  });
});

// ─── Test 4: No expose() call ───────────────────────────────────────────────

describe("LT-004: no expose() — members from Props, attributes empty", () => {
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
    const decl = getDeclaration(manifest);
    expect(decl.members).toHaveLength(1);
    expect(decl.members[0].name).toBe("value");
  });
});

// ─── Test 5: HTMLElementTagNameMap augmentation ──────────────────────────

describe("LT-002: HTMLElementTagNameMap augmentation coexistence", () => {
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
      // biome-ignore lint/suspicious/noExplicitAny: test
      .flatMap((m: any) => m.declarations ?? [])
      // biome-ignore lint/suspicious/noExplicitAny: test
      .filter((d: any) => d.customElement === true);
    expect(decls).toHaveLength(1);
  });

  test("tag name is correct despite augmentation", () => {
    const manifest = runPlugin(src);
    expect(getDeclaration(manifest).tagName).toBe("map-counter");
  });
});

// ─── Test 6: Parser-backed attributes ──────────────────────────────────────

describe("LT-004: expose() with as* parsers", () => {
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
    const decl = getDeclaration(manifest);
    expect(decl.attributes).toHaveLength(3);
  });

  test("sets name and fieldName on each attribute", () => {
    const manifest = runPlugin(parserSrc);
    const decl = getDeclaration(manifest);
    expect(decl.attributes[0]).toMatchObject({
      name: "count",
      fieldName: "count",
    });
    expect(decl.attributes[1]).toMatchObject({
      name: "active",
      fieldName: "active",
    });
    expect(decl.attributes[2]).toMatchObject({
      name: "label",
      fieldName: "label",
    });
  });

  test("copies type from matching member when type checker is provided", () => {
    const manifest = runPluginWithTypeChecker(parserSrc);
    const decl = getDeclaration(manifest);
    // biome-ignore lint/suspicious/noExplicitAny: test
    const countAttr = decl.attributes.find((a: any) => a.name === "count");
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

describe("LT-004: expose() with asParser()", () => {
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
    const decl = getDeclaration(manifest);
    expect(decl.attributes).toHaveLength(1);
    expect(decl.attributes[0]).toMatchObject({
      name: "data",
      fieldName: "data",
    });
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
    const manifest = create({ modules, plugins: [leTrucPlugin()] });
    rmSync(root, { recursive: true, force: true });
    const decl = getDeclaration(manifest);
    // Without resolution, the import map stores '../../..' which never equals
    // '@zeix/le-truc' and attributes stay empty. With resolution, the owning
    // package.json name is used, so the attribute is detected.
    expect(decl.attributes ?? []).toHaveLength(1);
    expect(decl.attributes[0]).toMatchObject({
      name: "count",
      fieldName: "count",
    });
  });
});

// ─── Test 8: superclass package field for built-in types ────────────────────
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
      .flatMap((m: any) => m.declarations ?? [])
      .find((d: any) => d.name === "StubEl");
    expect(stubDecl?.superclass).toMatchObject({
      name: "HTMLElement",
      package: "global:",
    });
  });
});
