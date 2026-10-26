/**
 * Minimal duplicate-key-strict YAML reader for `contracts/openapi.yaml`.
 *
 * The smoke suites must not add a YAML dependency, and this contract uses a
 * regular subset: block mappings, block sequences (scalar and mapping items),
 * flow mappings/sequences, folded and literal block scalars. Anything outside
 * that subset fails loudly rather than being skipped, so a contract rewrite
 * cannot silently disable smoke validation.
 */
export type YamlValue = unknown;
export type YamlMapping = Record<string, YamlValue>;

function fail(message: string): never {
  throw new Error(`contract YAML subset reader: ${message}`);
}

const SEQUENCE_ITEM = /^-(?:\s|$)/;

export function parseYamlSubset(source: string): YamlMapping {
  const lines = source
    .replaceAll("\t", "  ")
    .split("\n")
    .map(line => line.replace(/\s+$/, ""));
  let cursor = 0;

  const indentationOf = (line: string): number => line.length - line.trimStart().length;
  const contentOf = (line: string): string => line.trim();
  const isSkippable = (line: string): boolean =>
    contentOf(line).length === 0 || contentOf(line).startsWith("#");

  const skipBlanks = (): void => {
    while (cursor < lines.length && isSkippable(lines[cursor]!)) cursor += 1;
  };

  const parseScalar = (text: string): YamlValue => {
    const value = text.trim();
    if (value.length === 0 || value === "~" || value === "null") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^-?\d+\.\d+$/.test(value)) return Number(value);
    if ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith("\"") && value.endsWith("\""))) {
      return value.slice(1, -1);
    }
    return value;
  };

  const parseFlow = (text: string): YamlValue => {
    const value = text.trim();
    if (value.length === 0) return null;
    if (value === "[]") return [];
    if (value === "{}") return {};
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) fail(`unterminated flow sequence in the contract: ${value}`);
      const body = value.slice(1, -1).trim();
      return body.length === 0 ? [] : splitFlow(body).map(entry => parseFlow(entry));
    }
    if (!value.startsWith("{")) return parseScalar(value);
    const inner = value.slice(1, value.lastIndexOf("}"));
    const mapping: Record<string, YamlValue> = {};
    for (const entry of splitFlow(inner)) {
      const separator = entry.indexOf(":");
      if (separator < 0) fail(`unsupported flow entry in the contract: ${entry}`);
      const key = entry.slice(0, separator).trim();
      const raw = entry.slice(separator + 1).trim();
      mapping[key] = raw.startsWith("{") || raw.startsWith("[") ? parseFlow(raw) : parseScalar(raw);
    }
    return mapping;
  };

  /** Splits a flow collection body on top-level commas, respecting nesting. */
  const splitFlow = (body: string): string[] => {
    const tokens: string[] = [];
    let token = "";
    let depth = 0;
    for (const character of body) {
      if (character === "{" || character === "[") depth += 1;
      if (character === "}" || character === "]") depth -= 1;
      if (character === "," && depth === 0) {
        tokens.push(token);
        token = "";
        continue;
      }
      token += character;
    }
    if (token.trim().length > 0) tokens.push(token);
    return tokens;
  };

  const parseValue = (text: string): YamlValue =>
    text.trim().startsWith("{") || text.trim().startsWith("[") ? parseFlow(text) : parseScalar(text);

  /** `>-`, `>`, `|-`, `|` — the block scalar forms used for long descriptions. */
  const BLOCK_SCALAR = /^[>|][+-]?\d*$/;
  const blockScalarMarker = (text: string): string | undefined =>
    BLOCK_SCALAR.test(text.trim()) ? text.trim() : undefined;

  /** Folded/literal block scalar used for long descriptions. */
  const consumeBlockScalar = (indicator: string, parentIndent: number): string => {
    const pieces: string[] = [];
    let blockIndent = -1;
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (contentOf(line).length === 0) {
        pieces.push("");
        cursor += 1;
        continue;
      }
      const indent = indentationOf(line);
      if (indent <= parentIndent) break;
      if (blockIndent < 0) blockIndent = indent;
      pieces.push(line.slice(Math.min(blockIndent, indent)));
      cursor += 1;
    }
    const joined = pieces.join(indicator.startsWith(">") ? " " : "\n").trim();
    return joined;
  };

  const parseMapping = (indent: number): Record<string, YamlValue> => {
    const mapping: Record<string, YamlValue> = {};
    for (;;) {
      skipBlanks();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      const lineIndent = indentationOf(line);
      if (lineIndent < indent) break;
      const content = contentOf(line);
      if (lineIndent > indent || SEQUENCE_ITEM.test(content)) {
        fail(`unexpected indentation in contracts/openapi.yaml: ${line}`);
      }
      const separator = content.indexOf(":");
      if (separator < 0) fail(`unparsable YAML line: ${line}`);
      const key = content.slice(0, separator).trim();
      const raw = content.slice(separator + 1).trim();
      if (key in mapping) fail(`duplicate YAML key "${key}" in contracts/openapi.yaml`);
      cursor += 1;
      if (raw.length > 0) {
        const block = blockScalarMarker(raw);
        if (block !== undefined) {
          mapping[key] = consumeBlockScalar(block, indent);
        } else if (raw.startsWith("&") || raw.startsWith("*")) {
          fail(`YAML anchors are outside the supported subset: ${line}`);
        } else {
          mapping[key] = parseValue(raw);
        }
        continue;
      }
      skipBlanks();
      const next = lines[cursor];
      if (next === undefined || indentationOf(next) <= indent) {
        mapping[key] = null;
        continue;
      }
      // Two child shapes are possible. Either the value opens a block sequence
      // of scalars (`key:\n  - A\n  - B`), or it opens a nested block. The
      // canonical contract indents nested blocks by exactly two spaces; most
      // sequence items inside a nested block stay flat, so only the first
      // deeper line marks a nested block.
      const nextIndent = indentationOf(next);
      const nextContent = contentOf(next);
      if (SEQUENCE_ITEM.test(nextContent)) {
        let probe = cursor;
        let isScalarList = true;
        for (;;) {
          const candidate = lines[probe];
          if (candidate === undefined) break;
          if (isSkippable(candidate)) break;
          if (indentationOf(candidate) <= indent) break;
          if (!SEQUENCE_ITEM.test(contentOf(candidate))) break;
          const item = contentOf(candidate).replace(SEQUENCE_ITEM, "").trim();
          if (item.length === 0 || item.includes(":")) {
            isScalarList = false;
            break;
          }
          probe += 1;
        }
        const moreThanOneLine = lines[probe] !== undefined
          && !isSkippable(lines[probe]!)
          && indentationOf(lines[probe]!) > nextIndent;
        if (!isScalarList || moreThanOneLine) {
          mapping[key] = parseNode(nextIndent);
          continue;
        }
        const items: string[] = [];
        while (cursor < probe) {
          items.push(contentOf(lines[cursor]!).replace(SEQUENCE_ITEM, "").trim());
          cursor += 1;
        }
        mapping[key] = items.map(item => parseValue(item));
        continue;
      }
      mapping[key] = parseNode(nextIndent);
    }
    return mapping;
  };

  const parseSequence = (indent: number): YamlValue[] => {
    const items: YamlValue[] = [];
    for (;;) {
      skipBlanks();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      const lineIndent = indentationOf(line);
      if (lineIndent !== indent) break;
      const content = contentOf(line);
      if (!SEQUENCE_ITEM.test(content)) break;
      const inline = content.replace(SEQUENCE_ITEM, "").trim();
      cursor += 1;
      if (inline.length === 0) {
        skipBlanks();
        const next = lines[cursor];
        items.push(next === undefined || indentationOf(next) <= indent
          ? null
          : parseNode(indentationOf(next)));
        continue;
      }
      const separator = inline.indexOf(":");
      const scalarStyle = inline.startsWith("{") || inline.startsWith("[")
        || (separator >= 0 && inline[0] === "'" && inline.indexOf("':") !== 0);
      if (separator < 0 || scalarStyle) {
        items.push(parseValue(inline));
        continue;
      }
      // Sequence entry that opens a mapping: `- key: value` continues at the
      // indentation of `key`; an empty value may itself open a nested block.
      const entryIndent = indent + 2;
      const mapping: Record<string, YamlValue> = {};
      const key = inline.slice(0, separator).trim();
      const raw = inline.slice(separator + 1).trim();
      const block = raw.length > 0 ? blockScalarMarker(raw) : undefined;
      if (block !== undefined) {
        mapping[key] = consumeBlockScalar(block, entryIndent);
      } else if (raw.length > 0) {
        mapping[key] = parseValue(raw);
      } else {
        skipBlanks();
        const next = lines[cursor];
        mapping[key] = next === undefined || indentationOf(next) <= entryIndent
          ? null
          : parseNode(indentationOf(next));
      }
      skipBlanks();
      const following = lines[cursor];
      if (following !== undefined && !isSkippable(following)
        && indentationOf(following) === entryIndent
        && !SEQUENCE_ITEM.test(contentOf(following))) {
        Object.assign(mapping, parseMapping(entryIndent));
      }
      items.push(mapping);
    }
    return items;
  };

  const parseNode = (indent: number): YamlValue => {
    skipBlanks();
    const line = lines[cursor];
    if (line === undefined) return null;
    return SEQUENCE_ITEM.test(contentOf(line)) ? parseSequence(indent) : parseMapping(indent);
  };

  skipBlanks();
  const document = parseMapping(0);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("contracts/openapi.yaml must parse to a mapping");
  }
  return document;
}
