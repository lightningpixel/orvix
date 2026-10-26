import type { Node } from "web-tree-sitter";

/**
 * Receiver types, read from what the source declares and nothing else.
 *
 * `r.save()` has as many candidates as the project has methods called save,
 * and without a type the resolver rightly refuses to pick one. But the type is
 * very often written down: `r: Repo`, `Repo r`, `new Repo()`, a field, or
 * `this`. A declared type is evidence in the same way an import is, so using
 * it does not break the rule that resolution never guesses.
 *
 * Nothing is inferred beyond the declaration: no return types, no flow, no
 * generics. A receiver whose type is not spelled out stays unknown.
 */

/** Stands for the enclosing class; extract.ts turns it into that class's name. */
export const THIS = "this";

interface Declaration {
  name: string;
  type: string;
  /** Byte range the name is visible in. */
  start: number;
  end: number;
  /** Where it is declared; a local is visible only after this point. */
  at: number;
  /** A class member, reached through `this.name` as well as `name`. */
  field: boolean;
}

/** Languages whose receivers are typed. Go and Rust methods carry no container yet. */
const TYPED = new Set(["typescript", "tsx", "javascript", "java", "csharp", "python", "cpp", "c"]);

/** Nodes whose children are local to them: a function or a class body. */
const SCOPES = new Set([
  // ECMAScript
  "function_declaration", "function_expression", "arrow_function", "method_definition",
  "generator_function_declaration", "class_body",
  // Java, C#
  "method_declaration", "constructor_declaration", "local_function_statement", "declaration_list",
  // Python
  "function_definition", "class_definition",
  // C++
  "field_declaration_list", "lambda_expression",
]);

/** Every typed name in a file, collected in one walk. */
export class ReceiverTypes {
  private readonly declarations: Declaration[] = [];

  constructor(
    root: Node,
    private readonly languageId: string,
  ) {
    if (TYPED.has(languageId)) this.walk(root);
  }

  /**
   * The declared type of a member call's receiver, THIS for this/self, or
   * undefined when the source does not say.
   */
  receiverOf(name: Node): string | undefined {
    if (!TYPED.has(this.languageId)) return undefined;
    const target = receiverNode(name);
    if (!target) return undefined;

    if (isThis(target)) return THIS;

    if (target.type === "identifier") return this.typeOf(target.text, target.startIndex, false);

    // `this.store.save()`: the field's declared type.
    const field = thisField(target);
    if (field) return this.typeOf(field, target.startIndex, true);

    return undefined;
  }

  private typeOf(name: string, at: number, fieldOnly: boolean): string | undefined {
    let best: Declaration | undefined;
    for (const declaration of this.declarations) {
      if (declaration.name !== name || (fieldOnly && !declaration.field)) continue;
      if (at < declaration.start || at >= declaration.end) continue;
      if (!declaration.field && declaration.at > at) continue;
      if (!best || declaration.end - declaration.start < best.end - best.start) best = declaration;
    }
    return best?.type;
  }

  private walk(node: Node): void {
    for (const found of declared(node, this.languageId)) {
      const scope = scopeOf(node);
      this.declarations.push({
        ...found,
        start: scope?.startIndex ?? 0,
        end: scope?.endIndex ?? Infinity,
        at: node.startIndex,
      });
    }
    for (const child of node.namedChildren) if (child) this.walk(child);
  }
}

/** The names a node declares, with their types. */
function declared(node: Node, languageId: string): Array<{ name: string; type: string; field: boolean }> {
  const field = (n: Node | null | undefined, t: string | undefined, isField = false) =>
    n && t ? [{ name: n.text, type: t, field: isField }] : [];

  switch (node.type) {
    // TypeScript
    case "variable_declarator":
      if (languageId === "java") {
        const parent = node.parent;
        const type = parent?.childForFieldName("type");
        const declaredType = type?.text === "var" ? created(node.childForFieldName("value")) : baseType(type);
        return field(node.childForFieldName("name"), declaredType, parent?.type === "field_declaration");
      }
      if (languageId === "csharp") {
        const declaration = node.parent;
        const type = declaration?.childForFieldName("type");
        const value = node.namedChildren.find((child) => child?.type === "object_creation_expression");
        const declaredType = type?.type === "implicit_type" ? created(value) : baseType(type);
        return field(node.childForFieldName("name"), declaredType, declaration?.parent?.type === "field_declaration");
      }
      return field(
        node.childForFieldName("name"),
        annotated(node.childForFieldName("type")) ?? created(node.childForFieldName("value")),
      );
    case "required_parameter":
    case "optional_parameter":
      return field(node.childForFieldName("pattern"), annotated(node.childForFieldName("type")));
    case "public_field_definition":
      return field(node.childForFieldName("name"), annotated(node.childForFieldName("type")), true);

    // Java, C#
    case "formal_parameter":
    case "parameter":
      if (languageId === "python") return [];
      return field(node.childForFieldName("name"), baseType(node.childForFieldName("type")));

    // Python
    case "typed_parameter":
      return field(node.namedChildren.find((child) => child?.type === "identifier"), baseType(node.childForFieldName("type")));
    case "assignment":
      return languageId === "python"
        ? field(node.childForFieldName("left"), baseType(node.childForFieldName("type")))
        : [];

    // C++
    case "parameter_declaration":
    case "declaration":
    case "field_declaration": {
      if (languageId !== "cpp" && languageId !== "c") return [];
      const type = baseType(node.childForFieldName("type"));
      return node.childrenForFieldName("declarator").flatMap((declarator) =>
        field(innermostName(declarator), type, node.type === "field_declaration"),
      );
    }

    default:
      return [];
  }
}

/**
 * The object a member call is made on. Java names the callee on the
 * invocation itself; elsewhere it sits in a member access one level up, so
 * either way the callee's parent is the node holding the object.
 */
function receiverNode(name: Node): Node | undefined {
  return name.parent ? objectOf(name.parent) : undefined;
}

/** The object side of a member access, in each grammar's spelling. */
function objectOf(access: Node): Node | undefined {
  for (const fieldName of ["object", "expression", "argument", "operand", "value"]) {
    const found = access.childForFieldName(fieldName);
    if (found) return found;
  }
  // C# writes `this.Save()` with `this` as an unnamed child of the access.
  const first = access.child(0);
  return first?.type === "this" ? first : undefined;
}

function isThis(node: Node): boolean {
  return node.type === "this" || node.type === "self" || (node.type === "identifier" && node.text === "self");
}

/** `this.x` / `self.x` / `this->x`, as the name x. */
function thisField(access: Node): string | undefined {
  const object = objectOf(access);
  if (!object || !isThis(object)) return undefined;
  const member =
    access.childForFieldName("property") ??
    access.childForFieldName("field") ??
    access.childForFieldName("attribute") ??
    access.childForFieldName("name");
  return member?.text;
}

function scopeOf(node: Node): Node | undefined {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (SCOPES.has(ancestor.type)) return ancestor;
  }
  return undefined;
}

/** `: Repo` in TypeScript. */
function annotated(annotation: Node | null): string | undefined {
  return annotation ? baseType(annotation.namedChildren[0] ?? null) : undefined;
}

/** `new Repo()`, in any of the spellings. */
function created(value: Node | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.type === "new_expression") return baseType(value.childForFieldName("constructor"));
  if (value.type === "object_creation_expression") return baseType(value.childForFieldName("type"));
  return undefined;
}

/**
 * The class a type expression names: `Repo<T>`, `ns.Repo`, `Repo*`, `const
 * Repo&` all name Repo.
 */
function baseType(type: Node | null | undefined): string | undefined {
  if (!type) return undefined;
  const text = type.text.replace(/<[^]*$/, "").replace(/\bconst\b|[*&?[\]\s]/g, "");
  const name = text.split(/::|\./).pop();
  return name && /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/** The identifier at the bottom of a C++ declarator: `*r`, `&r`, `r = …`. */
function innermostName(declarator: Node): Node | undefined {
  if (declarator.type === "identifier" || declarator.type === "field_identifier") return declarator;
  const inner = declarator.childForFieldName("declarator");
  return inner ? innermostName(inner) : undefined;
}
