import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@custom-elements-manifest/analyzer";
import type { TypeChecker } from "typescript";

// `ts` and `node` in CEM plugin hooks come from CEM's bundled TypeScript (~5.4),
// which has different SyntaxKind enum values than this package's peer TypeScript (^5.0).
// All uses of these parameters are typed `any` to avoid version-mismatch errors.

const LE_TRUC_PACKAGE = "@zeix/le-truc";

// Resolve an import specifier against the importing file. Relative specifiers
// (e.g. '../../..') that resolve to a package root are rewritten to that
// package's published name (e.g. '@zeix/le-truc'), so the import-map check in
// analyzePhase matches regardless of whether the consumer imported the package
// by name or by relative path into its own monorepo/source tree.
const packageJsonCache = new Map<string, string | null>();

function readPackageName(pkgDir: string): string | null {
  if (packageJsonCache.has(pkgDir)) return packageJsonCache.get(pkgDir) ?? null;
  let result: string | null = null;
  try {
    const raw = readFileSync(resolve(pkgDir, "package.json"), "utf8");
    const name = JSON.parse(raw)?.name;
    if (typeof name === "string" && name) result = name;
  } catch {
    // Not a package directory (no package.json or unreadable) — fall through.
  }
  packageJsonCache.set(pkgDir, result);
  return result;
}

// Walk up from `resolved` until a package.json with a `name` is found.
// Returns that name, or null if none is found before the filesystem root.
function findOwningPackage(resolved: string): string | null {
  let cur = resolved;
  // Guard against symlink loops / absurd depth.
  for (let i = 0; i < 32; i++) {
    const pkgName = readPackageName(cur);
    if (pkgName) return pkgName;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function normalizeSpecifier(specifier: string, importer: string): string {
  // Bare specifiers (e.g. '@zeix/le-truc', '@zeix/le-truc/parsers') need no
  // resolution — only the package scope matters.
  if (!specifier.startsWith(".")) {
    const scope = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    return scope ?? specifier;
  }
  // Relative specifiers: resolve against the importing file, then find the
  // nearest ancestor package.json. If `index` is implied (no extension), a
  // directory or package root is the most likely target.
  const resolved = resolve(dirname(importer), specifier);
  return findOwningPackage(resolved) ?? specifier;
}

function tagToPascalCase(tag: string): string {
  return tag
    .split("-")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join("");
}

function getCommentText(comment: unknown): string {
  if (comment == null) return "";
  if (typeof comment === "string") return comment;
  if (Array.isArray(comment))
    return (comment as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("");
  return "";
}

// biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
function findJsDocAncestor(node: any): any {
  // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
  let cur: any = node;
  while (cur.parent) {
    cur = cur.parent;
    if (Array.isArray(cur.jsDoc) && cur.jsDoc.length > 0) return cur;
  }
  return undefined;
}

function parseNameDesc(text: string): { name: string; description: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("- "))
    return { name: "", description: trimmed.slice(2).trim() };
  const idx = trimmed.indexOf(" - ");
  if (idx !== -1)
    return {
      name: trimmed.slice(0, idx).trim(),
      description: trimmed.slice(idx + 3).trim(),
    };
  return { name: trimmed, description: "" };
}

// biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
function findExposeCall(ts: any, node: any): any | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
  let found: any;
  // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
  function visit(n: any): void {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "expose" &&
      n.arguments.length > 0 &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function getImportMap(
  context: Record<string, unknown>,
  filename: string,
): Map<string, string> {
  if (!context.leTrucImportMaps) context.leTrucImportMaps = Object.create(null);
  const maps = context.leTrucImportMaps as Record<string, Map<string, string>>;
  if (!maps[filename]) maps[filename] = new Map();
  return maps[filename];
}

export function leTrucPlugin(getTypeChecker?: () => TypeChecker): Plugin {
  return {
    name: "cem-plugin-le-truc",

    // Build import map keyed by local name → module specifier
    collectPhase({
      ts,
      node,
      context,
    }: {
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      ts: any;
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      node: any;
      context: Record<string, unknown>;
    }): void {
      if (!ts.isImportDeclaration(node)) return;
      const rawSpecifier: string = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      const filename: string = node.getSourceFile().fileName;
      const specifier = normalizeSpecifier(rawSpecifier, filename);
      const map = getImportMap(context, filename);
      for (const el of bindings.elements) {
        map.set(el.name.text as string, specifier);
      }
    },

    analyzePhase({
      ts,
      node,
      moduleDoc,
      context,
    }: {
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      ts: any;
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      node: any;
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      moduleDoc: any;
      context: Record<string, unknown>;
    }): void {
      // Detect defineComponent CallExpression
      if (!ts.isCallExpression(node)) return;
      if (node.expression.getText() !== "defineComponent") return;

      const firstArg = node.arguments[0];
      if (!firstArg || !ts.isStringLiteral(firstArg)) return;

      const tagName: string = firstArg.text;
      const name = tagToPascalCase(tagName);

      // Extract description from JSDoc on the nearest ancestor that has one
      let description = "";
      const jsDocNode = findJsDocAncestor(node);
      if (jsDocNode) {
        // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
        const jsDocs: any[] = jsDocNode.jsDoc;
        const last = jsDocs[jsDocs.length - 1];
        if (last) description = getCommentText(last.comment);
      }

      const declaration: Record<string, unknown> = {
        kind: "class",
        customElement: true,
        tagName,
        name,
        description,
        members: [],
        attributes: [],
        slots: [],
        events: [],
        cssParts: [],
        cssProperties: [],
        demos: [],
      };

      // Resolve Props type via TypeScript type checker
      const typeArgNode = node.typeArguments?.[0];
      if (typeArgNode && getTypeChecker) {
        try {
          const checker = getTypeChecker();
          // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
          const propsType = checker.getTypeFromTypeNode(typeArgNode as any);
          for (const sym of checker.getPropertiesOfType(propsType)) {
            const field: Record<string, unknown> = {
              kind: "field",
              name: sym.getName(),
              type: {
                text: checker.typeToString(checker.getTypeOfSymbol(sym)),
              },
            };
            const docText = sym
              .getDocumentationComment(checker)
              .map((c) => c.text)
              .join("");
            if (docText) field.description = docText;
            (declaration.members as unknown[]).push(field);
          }
        } catch {
          // Type checker unavailable — members remain empty
        }
      }

      // Traverse factory body for expose({}) to find attribute-backed props
      const factoryArg = node.arguments[1];
      if (factoryArg) {
        const exposeCall = findExposeCall(ts, factoryArg);
        if (exposeCall) {
          const objLit = exposeCall.arguments[0];
          const filename: string = node.getSourceFile().fileName;
          const importMap = getImportMap(context, filename);

          for (const prop of objLit.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const init = prop.initializer;
            if (!ts.isCallExpression(init)) continue;
            const callee = init.expression;
            if (!ts.isIdentifier(callee)) continue;
            const calleeName: string = callee.text;

            const isLeTrucParser =
              importMap.get(calleeName) === LE_TRUC_PACKAGE &&
              /^as[A-Z]/.test(calleeName);
            const isAsParser = calleeName === "asParser";
            if (!isLeTrucParser && !isAsParser) continue;

            const propName: string = ts.isIdentifier(prop.name)
              ? prop.name.text
              : prop.name.getText();
            const matchingField = (
              declaration.members as Array<Record<string, unknown>>
            ).find((m) => m.name === propName);

            const attr: Record<string, unknown> = {
              name: propName,
              fieldName: propName,
            };
            if (matchingField?.type) attr.type = matchingField.type;
            (declaration.attributes as unknown[]).push(attr);
          }
        }
      }

      // Extract @slot, @fires, @csspart, @cssprop JSDoc tags
      if (jsDocNode) {
        // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
        const jsDocs: any[] = jsDocNode.jsDoc;
        const last = jsDocs[jsDocs.length - 1];
        for (const tag of last?.tags ?? []) {
          const tn: string = tag.tagName.text;
          const commentText = getCommentText(tag.comment);
          switch (tn) {
            case "slot": {
              const { name: slotName, description: slotDesc } =
                parseNameDesc(commentText);
              (declaration.slots as unknown[]).push({
                name: slotName,
                description: slotDesc,
              });
              break;
            }
            case "fires": {
              const { name: evtName, description: evtDesc } =
                parseNameDesc(commentText);
              (declaration.events as unknown[]).push({
                name: evtName,
                type: { text: "CustomEvent" },
                description: evtDesc,
              });
              break;
            }
            case "csspart": {
              const { name: partName, description: partDesc } =
                parseNameDesc(commentText);
              (declaration.cssParts as unknown[]).push({
                name: partName,
                description: partDesc,
              });
              break;
            }
            case "cssprop": {
              const { name: propName, description: propDesc } =
                parseNameDesc(commentText);
              (declaration.cssProperties as unknown[]).push({
                name: propName,
                description: propDesc,
              });
              break;
            }
            case "demo": {
              // @demo {url} description
              // The URL in braces identifies the demo page; the remaining text
              // is a markdown description. Matches the CEM Demo interface.
              let url = "";
              let desc = "";
              const braceMatch = commentText.match(/^\{([^}]+)\}\s*(.*)$/s);
              if (braceMatch && braceMatch[1]) {
                url = braceMatch[1].trim();
                desc = (braceMatch[2] ?? "").trim();
              } else {
                // Fallback: treat the whole comment as a URL with no description
                url = commentText.trim();
              }
              if (url) {
                (declaration.demos as unknown[]).push({
                  url,
                  ...(desc ? { description: desc } : {}),
                });
              }
              break;
            }
          }
        }
      }

      moduleDoc.declarations = moduleDoc.declarations ?? [];
      moduleDoc.exports = moduleDoc.exports ?? [];
      moduleDoc.declarations.push(declaration);

      // The default analyzer emits a `js`/`default` export for
      // `export default defineComponent(...)` but can't resolve the call
      // expression's return value to a named declaration, so it omits
      // declaration.name. The CEM schema requires Reference.name, so without
      // this fixup `cem validate` reports "missing property 'name'" on every
      // component. Link the default export to our synthesised declaration.
      for (const exp of moduleDoc.exports as Array<Record<string, unknown>>) {
        if (exp.kind === "js" && exp.name === "default") {
          const declRef = exp.declaration as Record<string, unknown> | undefined;
          if (declRef && !declRef.name) declRef.name = name;
          break;
        }
      }

      moduleDoc.exports.push({
        kind: "custom-element-definition",
        name: tagName,
        declaration: { name, module: moduleDoc.path },
      });
    },

    // After all modules are analysed, fix up superclass references on
    // declarations handled by the default analyzer (e.g. structural-only
    // `class extends HTMLElement {}` stubs) so built-in types declare
    // `package: "global:"` per the CEM spec. Without it, `cem validate`
    // warns: "superclass HTMLElement is a built-in type but missing package
    // field". Our synthesised Le Truc declarations have no superclass field,
    // so this only touches declarations the default analyzer produced.
    packageLinkPhase({
      customElementsManifest,
    }: {
      // biome-ignore lint/suspicious/noExplicitAny: avoid version-mismatch errors
      customElementsManifest: any;
    }): void {
      const BUILT_INS = new Set([
        "HTMLElement",
        "SVGElement",
        "Document",
        "ShadowRoot",
        "Element",
        "Node",
      ]);
      for (const module of customElementsManifest.modules ?? []) {
        for (const decl of module.declarations ?? []) {
          const superclass = decl.superclass;
          if (
            superclass &&
            typeof superclass.name === "string" &&
            BUILT_INS.has(superclass.name) &&
            !superclass.package
          ) {
            superclass.package = "global:";
          }
        }
      }
    },
  };
}
