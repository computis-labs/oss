import { Effect, Result, Schema } from "effect";
import { localName, positionAt } from "./characters.ts";
import { openFrame, segment, store, toNode } from "./decoder-plan.ts";
import type { Frame, Step } from "./decoder-plan.ts";
import type { Encodable } from "./encoder.ts";
import { XmlDecodeError } from "./errors/xml-decode-error.ts";
import type { XmlParseError } from "./errors/xml-parse-error.ts";
import { firstIssue, issuePosition } from "./issue-path.ts";
import { DEFAULT_MAX_DEPTH, tokenize } from "./tokenizer.ts";
import type { RootPlan } from "./types.ts";

export interface DecoderOptions {
  /** Deepest element nesting the tokenizer accepts before it fails (default 256). */
  readonly maxDepth: number;
  /**
   * Removes the whitespace around the text of every leaf (default `false`). By default the text
   * is kept as written, as the XSD `whiteSpace="preserve"` of `xs:string` requires.
   */
  readonly trimText: boolean;
  /**
   * What to do with content the plan does not declare: elements, elements inside a leaf,
   * attributes (also on leaves and with a prefix such as `xsi:nil`) and children bound to a
   * namespace other than the root one, through their prefix or through a default namespace that
   * an `xmlns` below the root changes. `error` rejects it, `skip` drops it. `xmlns*` and
   * `xml:*` attributes are always accepted, and so are `xsi:schemaLocation` and
   * `xsi:noNamespaceSchemaLocation` on the root. A prefix that no `xmlns:prefix` in scope binds
   * fails in both modes, as Namespaces in XML requires.
   */
  readonly unknownElements: "error" | "skip";
}

export type Decode<S extends Encodable> = (
  xml: string,
) => Effect.Effect<S["Type"], XmlParseError | XmlDecodeError, S["DecodingServices"]>;

const XMLNS = "xmlns";
const XMLNS_PREFIXED = "xmlns:";
const XML_PREFIX = "xml";
const XML_PREFIXED = "xml:";
const ROOT_SCHEMA_LOCATIONS: ReadonlySet<string> = new Set([
  "xsi:noNamespaceSchemaLocation",
  "xsi:schemaLocation",
]);

interface Located {
  readonly offset: number;
  readonly text: string;
}

interface NamespaceScope {
  readonly depth: number;
  readonly namespace: string | undefined;
  readonly prefix: string;
}

class DecodeState {
  top: Frame;
  started = false;
  leaf: Step | undefined = undefined;
  leafText = "";
  skipDepth = 0;
  depth = 0;
  rootNamespace: string | undefined = undefined;
  defaultNamespace: string | undefined = undefined;
  rootDefault: string | undefined = undefined;
  defaultChanged = false;
  bindings: Map<string, string> | undefined = undefined;
  scopes: NamespaceScope[] | undefined = undefined;
  prefixedNames: Located[] | undefined = undefined;
  deferredFailure: Located | undefined = undefined;
  pendingQname: string | undefined = undefined;
  pendingPrefixed = false;
  pendingOffset = 0;
  pendingLastIndex = -1;
  failure: XmlDecodeError | undefined = undefined;

  constructor(root: Frame) {
    this.top = root;
  }
}

export const makeDecoder = <S extends Encodable>(
  schema: S,
  plan: RootPlan,
  options: Partial<DecoderOptions> = {},
): Decode<S> => {
  const skipUnknown = options.unknownElements === "skip";
  const trimText = options.trimText === true;
  const tokenizeOptions = { maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH };
  const decodeValue = Schema.decodeUnknownEffect(schema);
  const rootNode = toNode(plan.node, new Map());

  return (xml) =>
    Effect.suspend(
      (): Effect.Effect<S["Type"], XmlParseError | XmlDecodeError, S["DecodingServices"]> => {
        const root = openFrame(rootNode);
        const state = new DecodeState(root);

        const fail = (message: string, offset: number) => {
          const segments = state.leaf === undefined ? [] : [segment(state.leaf, state.top)];
          for (
            let current: Frame | undefined = state.top;
            current?.child !== undefined;
            current = current.parent
          ) {
            segments.push(segment(current.child, current.parent));
          }
          state.failure = XmlDecodeError.make({
            path: [plan.name, ...segments.toReversed()].join("."),
            position: positionAt(xml, offset),
            reason: message,
          });
          return false;
        };

        const declare = (prefix: string, namespace: string) => {
          state.bindings ??= new Map();
          if (state.depth > 1) {
            state.scopes ??= [];
            state.scopes.push({
              depth: state.depth,
              namespace: state.bindings.get(prefix),
              prefix,
            });
          }
          state.bindings.set(prefix, namespace);
        };

        const declareDefault = (namespace: string, offset: number) => {
          declare("", namespace);
          state.defaultNamespace = namespace === "" ? undefined : namespace;
          if (state.depth > 1) {
            state.defaultChanged = true;
            if (state.skipDepth === 0 && state.pendingQname === undefined) {
              state.pendingQname = (state.leaf ?? state.top.child)?.name;
              state.pendingPrefixed = false;
              state.pendingOffset = xml.lastIndexOf("<", offset);
            }
          }
        };

        const unwind = (scoped: NamespaceScope[]) => {
          for (
            let scope = scoped.at(-1);
            scope !== undefined && scope.depth === state.depth;
            scope = scoped.at(-1)
          ) {
            scoped.pop();
            if (scope.namespace === undefined) {
              state.bindings?.delete(scope.prefix);
            } else {
              state.bindings?.set(scope.prefix, scope.namespace);
            }
            if (scope.prefix === "") {
              state.defaultNamespace = scope.namespace === "" ? undefined : scope.namespace;
            }
          }
        };

        const checkNamespace = (qname: string) => {
          const colon = qname.indexOf(":");
          const namespace =
            colon === -1 ? state.defaultNamespace : state.bindings?.get(qname.slice(0, colon));
          if (state.top === root && state.leaf === undefined) {
            state.rootNamespace = namespace;
            state.rootDefault = state.defaultNamespace;
            return plan.namespace === undefined || namespace === plan.namespace
              ? true
              : fail(
                  `Invalid document namespace: expected ${plan.namespace}, found ${namespace ?? "none"}.`,
                  state.pendingOffset,
                );
          }
          if (namespace !== undefined && namespace === state.rootNamespace) {
            return true;
          }
          if (!skipUnknown) {
            return fail(
              `Element ${qname} is not in the document namespace ${state.rootNamespace ?? "(none)"}.`,
              state.pendingOffset,
            );
          }
          if (state.leaf === undefined) {
            state.top = state.top.parent ?? root;
          } else {
            state.leaf = undefined;
          }
          state.top.lastIndex = state.pendingLastIndex;
          state.skipDepth = 1;
          return true;
        };

        const checkPrefixes = (names: Located[]) => {
          for (const { offset, text } of names) {
            const prefix = text.slice(0, text.indexOf(":"));
            if (prefix !== XML_PREFIX && state.bindings?.has(prefix) !== true) {
              return fail(`Unbound namespace prefix "${prefix}".`, offset);
            }
          }
          names.length = 0;
          return true;
        };

        const checkLater = (qname: string, offset: number) => {
          if (!qname.includes(":")) {
            return false;
          }
          state.prefixedNames ??= [];
          state.prefixedNames.push({ offset, text: qname });
          return true;
        };

        const failLater = (message: string, offset: number) => {
          state.deferredFailure ??= { offset, text: message };
          return true;
        };

        const result = tokenize(
          xml,
          {
            attribute: (qname, value, offset) => {
              if (qname === XMLNS) {
                declareDefault(value, offset);
                return true;
              }
              if (qname.startsWith(XMLNS_PREFIXED)) {
                declare(qname.slice(XMLNS_PREFIXED.length), value);
                return true;
              }
              if (state.skipDepth > 0) {
                checkLater(qname, offset);
                return true;
              }
              const attribute =
                state.leaf === undefined ? state.top.element.attributes.get(qname) : undefined;
              if (attribute !== undefined) {
                state.top.value[attribute.name] = value;
                return true;
              }
              const hasPrefix = checkLater(qname, offset);
              if (
                skipUnknown ||
                qname.startsWith(XML_PREFIXED) ||
                (state.top === root && state.leaf === undefined && ROOT_SCHEMA_LOCATIONS.has(qname))
              ) {
                return true;
              }
              const message = `Unexpected attribute: ${qname}.`;
              return hasPrefix ? failLater(message, offset) : fail(message, offset);
            },
            close: () => {
              if (state.scopes !== undefined) {
                unwind(state.scopes);
              }
              state.depth -= 1;
              if (state.skipDepth > 0) {
                state.skipDepth -= 1;
                return true;
              }
              const frame = state.top;
              if (state.leaf !== undefined) {
                store(frame, state.leaf, trimText ? state.leafText.trim() : state.leafText);
                state.leaf = undefined;
                return true;
              }
              state.top = frame.parent ?? root;
              const { child, element, lists, parent, value } = frame;
              if (lists !== undefined) {
                for (let slot = 0; slot < lists.length; slot += 1) {
                  const list = lists[slot];
                  const step = element.lists[slot];
                  if (list !== undefined && step !== undefined) {
                    value[step.name] = list;
                  }
                }
              }
              for (const key of element.required) {
                value[key] ??= [];
              }
              if (child !== undefined && parent !== undefined) {
                store(parent, child, value);
              }
              return true;
            },
            keepWhitespace: () => !trimText && state.leaf !== undefined && state.skipDepth === 0,
            openEnd: () => {
              if (
                state.prefixedNames !== undefined &&
                state.prefixedNames.length > 0 &&
                !checkPrefixes(state.prefixedNames)
              ) {
                return false;
              }
              if (state.deferredFailure !== undefined) {
                return fail(state.deferredFailure.text, state.deferredFailure.offset);
              }
              if (state.pendingQname === undefined) {
                return true;
              }
              const qname = state.pendingQname;
              state.pendingQname = undefined;
              return (
                (!state.pendingPrefixed && state.defaultNamespace === state.rootDefault) ||
                checkNamespace(qname)
              );
            },
            openStart: (qname, offset) => {
              state.depth += 1;
              if (state.skipDepth > 0) {
                state.skipDepth += 1;
                checkLater(qname, offset);
                return true;
              }
              if (!state.started) {
                if (localName(qname) !== plan.name) {
                  return fail(`Unexpected root element: ${qname}.`, offset);
                }
                checkLater(qname, offset);
                state.started = true;
                state.pendingQname = qname;
                state.pendingPrefixed = true;
                state.pendingOffset = offset;
                return true;
              }
              const { top } = state;
              const { children, sequence } = top.element;
              const from = Math.max(top.lastIndex, 0);
              const exact =
                state.leaf === undefined
                  ? (sequence.find((step, index) => index >= from && step.name === qname) ??
                    children.get(qname))
                  : undefined;
              const prefixedChild =
                state.leaf === undefined && exact === undefined
                  ? children.get(localName(qname))
                  : undefined;
              const child = exact ?? prefixedChild;
              const prefixed = prefixedChild !== undefined;
              if (child === undefined) {
                const hasPrefix = checkLater(qname, offset);
                if (skipUnknown) {
                  state.skipDepth = 1;
                  return true;
                }
                const message = `Unexpected element: ${qname}.`;
                if (!hasPrefix) {
                  return fail(message, offset);
                }
                state.skipDepth = 1;
                return failLater(message, offset);
              }
              if (child.index < top.lastIndex) {
                return fail(`Element out of sequence: ${qname}.`, offset);
              }
              if (child.index === top.lastIndex && !child.many) {
                return fail(`Repeated element: ${qname}.`, offset);
              }
              if (prefixed) {
                checkLater(qname, offset);
              }
              if (prefixed || state.defaultChanged) {
                state.pendingQname = qname;
                state.pendingPrefixed = prefixed;
                state.pendingOffset = offset;
              }
              state.pendingLastIndex = top.lastIndex;
              top.lastIndex = child.index;
              if (child.element === undefined) {
                state.leaf = child;
                state.leafText = "";
              } else {
                state.top = openFrame(child.element, child, top);
              }
              return true;
            },
            text: (value, offset) => {
              if (state.skipDepth > 0) {
                return true;
              }
              if (state.leaf === undefined) {
                return fail("Unexpected text inside a structured element.", offset);
              }
              state.leafText = state.leafText === "" ? value : state.leafText + value;
              return true;
            },
          },
          tokenizeOptions,
        );

        if (Result.isFailure(result)) {
          return Effect.fail(result.failure);
        }
        if (state.failure !== undefined) {
          return Effect.fail(state.failure);
        }
        const input = root.value;
        return decodeValue(input).pipe(
          Effect.mapError((schemaError) => {
            const { keys, message, path } = firstIssue(plan.name, schemaError, input);
            return XmlDecodeError.make({
              cause: schemaError,
              path,
              position: issuePosition(xml, keys),
              reason: message,
            });
          }),
        );
      },
    );
};
