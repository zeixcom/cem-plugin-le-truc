import type { Plugin } from "@custom-elements-manifest/analyzer";
import type { TypeChecker } from "typescript";

// `ts` and `node` in CEM plugin hooks come from CEM's bundled TypeScript (~5.4),
// which has different SyntaxKind enum values than this package's peer TypeScript (^5.0).
// All uses of these parameters are typed `any` to avoid version-mismatch errors.

const LE_TRUC_PACKAGE = "@zeix/le-truc";

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

    // LT-004: Build import map keyed by local name → module specifier
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
      const specifier: string = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      const filename: string = node.getSourceFile().fileName;
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
      // LT-002: Detect defineComponent CallExpression
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
      };

      // LT-003: Resolve Props type via TypeScript type checker
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

      // LT-004: Traverse factory body for expose({}) to find attribute-backed props
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

      // LT-005: Extract @slot, @fires, @csspart, @cssprop JSDoc tags
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
          }
        }
      }

      moduleDoc.declarations = moduleDoc.declarations ?? [];
      moduleDoc.exports = moduleDoc.exports ?? [];
      moduleDoc.declarations.push(declaration);
      moduleDoc.exports.push({
        kind: "custom-element-definition",
        name: tagName,
        declaration: { name, module: moduleDoc.path },
      });
    },
  };
}
