import { Array, Match, Schema, SchemaAST, SchemaIssue } from "effect";
import type { XmlObject } from "./encoder.ts";

const exactNodes = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const exact = (ast: SchemaAST.AST): SchemaAST.AST => {
  const cached = exactNodes.get(ast);

  if (cached !== undefined) {
    return cached;
  }

  const rebuilt: SchemaAST.AST = Match.value(ast).pipe(
    Match.when(
      (node: SchemaAST.AST): node is SchemaAST.AST & { readonly encoding: SchemaAST.Encoding } =>
        node.encoding !== undefined,
      (node) => {
        const last = Array.lastNonEmpty(node.encoding);
        const to = exact(last.to);

        if (to === last.to) {
          return node;
        }

        const copy = {
          // oxlint-disable-next-line typescript/no-misused-spread -- the copy gets the prototype back below, as SchemaAST.replaceEncoding copies a node
          ...node,
          encoding: Array.append(
            Array.initNonEmpty(node.encoding),
            new SchemaAST.Link(to, last.transformation),
          ),
        };

        Reflect.setPrototypeOf(copy, Reflect.getPrototypeOf(node));

        return copy;
      },
    ),
    Match.when(SchemaAST.isObjects, (objects) => {
      if (objects.propertySignatures.length === 0) {
        return objects;
      }

      const declared = new Set(objects.propertySignatures.map((property) => property.name));

      const rejectUndeclared = new SchemaAST.Filter<XmlObject>((input, self) => {
        const key = Object.keys(input).find((name) => !declared.has(name));

        return key === undefined
          ? undefined
          : new SchemaIssue.Pointer([key], new SchemaIssue.UnexpectedKey(self, input[key]));
      });

      return new SchemaAST.Objects(
        SchemaAST.mapOrSame(objects.propertySignatures, (property) => {
          const type = exact(property.type);

          return type === property.type
            ? property
            : new SchemaAST.PropertySignature(property.name, type);
        }),
        objects.indexSignatures,
        objects.annotations,
        objects.checks,
        undefined,
        objects.context,
        [rejectUndeclared, ...(objects.encodingChecks ?? [])],
      );
    }),
    Match.when(SchemaAST.isArrays, (arrays) => {
      const elements = SchemaAST.mapOrSame(arrays.elements, exact);
      const rest = SchemaAST.mapOrSame(arrays.rest, exact);

      return elements === arrays.elements && rest === arrays.rest
        ? arrays
        : new SchemaAST.Arrays(
            arrays.isMutable,
            elements,
            rest,
            arrays.annotations,
            arrays.checks,
            undefined,
            arrays.context,
            arrays.encodingChecks,
          );
    }),
    Match.when(SchemaAST.isUnion, (union) => {
      const types = SchemaAST.mapOrSame(union.types, exact);

      return types === union.types
        ? union
        : new SchemaAST.Union(
            types,
            union.options,
            union.annotations,
            union.checks,
            undefined,
            union.context,
            union.encodingChecks,
          );
    }),
    Match.when(SchemaAST.isSuspend, (suspend) => {
      const target = suspend.thunk();
      const exactTarget = exact(target);

      return exactTarget === target
        ? suspend
        : new SchemaAST.Suspend(
            () => exactTarget,
            suspend.annotations,
            suspend.checks,
            undefined,
            suspend.context,
          );
    }),
    Match.orElse(() => ast),
  );

  exactNodes.set(ast, rebuilt);

  return rebuilt;
};

export const exactDecoder = <S extends Schema.Top>(schema: S) =>
  Schema.make<Schema.Decoder<S["Type"], S["DecodingServices"]>>(exact(schema.ast));
