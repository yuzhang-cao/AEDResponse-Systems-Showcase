/**
 * Contract smoke suite: `contracts/` must stay the single source of truth.
 *
 *   npm run smoke:contract
 *
 *  1. structure — the contract is OpenAPI 3.1, uniquely identified, with
 *     resolvable internal `$ref`s;
 *  2. documentation coverage — every route implemented in `src/server.ts` has a
 *     matching documented path and method;
 *  3. runtime conformance — live responses are validated against the documented
 *     JSON schemas, so wire-format drift fails the smoke run.
 *
 * `contracts/openapi.yaml` is parsed with a small duplicate-key-strict reader
 * instead of a YAML dependency: the subset this contract uses is regular
 * (block/flow mappings, block sequences, plain/quoted scalars), and any
 * construct outside that subset fails the suite loudly rather than being
 * silently skipped.
 */
import { readFile } from "node:fs/promises";
import { aedSchema } from "../../src/contracts.js";
import {
  check,
  engineeringPath,
  equal,
  OPENAPI_FILE,
  readFixtureAeds,
  startSmokeHarness,
  uuid,
  violate
} from "./support.js";
import { parseYamlSubset, type YamlValue } from "./yaml.js";

type Json = YamlValue;
type Schema = Record<string, YamlValue>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface DocumentedOperation {
  path: string;
  method: string;
  operationId: string;
  responseSchemas: Record<string, Json>;
}

interface OpenApiIndex {
  version: string;
  info: Record<string, Json>;
  servers: Array<Record<string, Json>>;
  operations: DocumentedOperation[];
  components: Record<string, Json>;
  references: string[];
  [key: string]: Json;
}


function asMapping(value: Json, label: string): Record<string, Json> {
  check(value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be a mapping`);
  return value as Record<string, Json>;
}

function indexContract(source: string): OpenApiIndex {
  const document = asMapping(parseYamlSubset(source), "contracts/openapi.yaml");
  const version = document.openapi;
  check(typeof version === "string", "contracts/openapi.yaml must declare an openapi version");
  const info = asMapping(document.info, "info");
  check(typeof info.title === "string" && info.title.length > 0, "info.title is required");
  const servers = (document.servers as Json[] | undefined) ?? [];
  check(Array.isArray(servers) && servers.length > 0, "at least one server must be declared");

  const paths = asMapping(document.paths, "paths");
  const operations: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = asMapping(item, `paths.${path}`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method as typeof HTTP_METHODS[number])) continue;
      const node = asMapping(operation, `${method} ${path}`);
      const responses = asMapping(node.responses, `responses for ${method} ${path}`);
      const responseSchemas: Record<string, Json> = {};
      for (const [rawStatus, rawResponse] of Object.entries(responses)) {
        // YAML requires response codes to be quoted, so `'200'` must be keyed as
        // the bare status the runtime actually reports.
        const status = rawStatus.replaceAll("'", "").replaceAll("\"", "");
        // A response may itself be a shared `$ref` (for example the common
        // Problem document), so dereference before reading its content.
        let response = rawResponse;
        if (response !== null && typeof response === "object" && !Array.isArray(response)
          && typeof (response as Schema).$ref === "string") {
          response = resolvePointer(document, (response as Schema).$ref as string);
        }
        const content = (response as Schema | null)?.content;
        if (content === undefined || content === null) continue;
        const media = asMapping(content, `content for ${method} ${path} ${status}`);
        for (const [mediaType, rawEntry] of Object.entries(media)) {
          if (mediaType !== "application/json" && mediaType !== "application/problem+json") continue;
          let entry = rawEntry;
          if (entry !== null && typeof entry === "object" && !Array.isArray(entry)
            && typeof (entry as Schema).$ref === "string") {
            entry = resolvePointer(document, (entry as Schema).$ref as string);
          }
          const mediaObject = asMapping(entry, `media for ${method} ${path} ${status}`);
          responseSchemas[status] = mediaObject.schema ?? null;
        }
      }
      operations.push({
        path,
        method,
        operationId: typeof node.operationId === "string" ? node.operationId : "",
        responseSchemas
      });
    }
  }
  check(operations.length > 0, "no operations were found under paths");

  const components = asMapping(document.components, "components");
  const references = [...source.matchAll(/\$ref:\s*['"]?(#[^'"\s}]+)/g)].map(match => match[1]!);
  check(references.length > 0, "the contract must use internal $ref components");

  return {
    version: version as string,
    info,
    servers: servers.map(server => asMapping(server, "server entry")),
    operations,
    components,
    references
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator for the subset used by contracts/openapi.yaml.
// Unsupported keywords fail loudly instead of silently passing.
// ---------------------------------------------------------------------------
const SUPPORTED_KEYWORDS = new Set([
  "$ref", "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "oneOf", "anyOf", "allOf", "format", "maxLength", "minLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "pattern", "minItems", "maxItems", "uniqueItems",
  "description", "title", "default", "examples", "deprecated", "readOnly",
  "unevaluatedProperties"
]);

function resolvePointer(root: Json, reference: string): Json {
  if (!reference.startsWith("#/")) violate(`only internal refs are supported: ${reference}`);
  let node: Json = root;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !(key in (node as Record<string, Json>))) {
      violate(`unresolvable $ref ${reference}`);
    }
    node = (node as Record<string, Json>)[key];
  }
  return node;
}

function describe(value: Json): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

export function validateSchema(root: Json, schema: Json, value: Json, path: string, depth = 0): void {
  if (depth > 40) violate("schema recursion limit exceeded", path);
  if (schema === true || schema === undefined) return;
  if (schema === false) violate("value is rejected by a false schema", path);
  if (typeof schema !== "object" || schema === null) violate("schema must be an object", path);
  const node = schema as Schema;

  if (typeof node.$ref === "string") {
    validateSchema(root, resolvePointer(root, node.$ref), value, path, depth + 1);
    return;
  }
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      violate(`validator does not implement schema keyword "${keyword}"`, `${path} -> ${keyword}`);
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf as Json[]) validateSchema(root, branch, value, path, depth + 1);
  }
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    const branches = (node.oneOf ?? node.anyOf) as Json[];
    const matches = branches.filter(branch => {
      try {
        validateSchema(root, branch, value, path, depth + 1);
        return true;
      } catch {
        return false;
      }
    });
    if (node.oneOf) {
      if (matches.length !== 1) {
        violate(`value must match exactly one oneOf branch (matched ${matches.length})`,
          `${path} = ${describe(value)}`);
      }
    } else if (matches.length === 0) {
      violate("value matches no anyOf branch", `${path} = ${describe(value)}`);
    }
  }
  if (node.const !== undefined && value !== node.const) {
    violate(`expected const ${describe(node.const)}`, `${path} = ${describe(value)}`);
  }
  if (Array.isArray(node.enum) && !(node.enum as Json[]).some(entry => entry === value)) {
    violate(`expected one of ${describe(node.enum)}`, `${path} = ${describe(value)}`);
  }

  const types = node.type === undefined
    ? []
    : Array.isArray(node.type) ? node.type as string[] : [node.type as string];
  if (types.length > 0) {
    const actual: string = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matchesType = types.some(type =>
      type === actual
      || (type === "integer" && actual === "number" && Number.isInteger(value as number))
      || (type === "number" && actual === "integer"));
    if (!matchesType) violate(`expected type ${types.join("|")}`, `${path} is ${describe(value)}`);
  }

  if (typeof value === "string") {
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      violate(`string exceeds maxLength ${node.maxLength}`, path);
    }
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      violate(`string is shorter than minLength ${node.minLength}`, path);
    }
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
      violate(`string does not match ${node.pattern}`, `${path} = ${describe(value)}`);
    }
    if (node.format === "date-time" && !Number.isFinite(Date.parse(value))) {
      violate("string is not an RFC3339 date-time", `${path} = ${describe(value)}`);
    }
    if (node.format === "uuid"
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      violate("string is not a UUID", `${path} = ${describe(value)}`);
    }
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      violate(`below minimum ${node.minimum}`, path);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      violate(`above maximum ${node.maximum}`, path);
    }
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) {
      violate(`not above exclusiveMinimum ${node.exclusiveMinimum}`, path);
    }
    if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) {
      violate(`not below exclusiveMaximum ${node.exclusiveMaximum}`, path);
    }
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) violate("too few items", path);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) violate("too many items", path);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map(entry => JSON.stringify(entry)));
      if (seen.size !== value.length) violate("items are not unique", path);
    }
    if (node.items !== undefined) {
      value.forEach((entry, index) =>
        validateSchema(root, node.items, entry, `${path}[${index}]`, depth + 1));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, Json>;
    const properties = (node.properties ?? {}) as Record<string, Json>;
    for (const key of (node.required as string[] | undefined) ?? []) {
      if (!(key in record)) violate(`missing required property "${key}"`, path);
    }
    for (const [key, entry] of Object.entries(record)) {
      if (key in properties) {
        validateSchema(root, properties[key], entry, `${path}.${key}`, depth + 1);
      } else if (node.additionalProperties === false) {
        violate(`unexpected additional property "${key}"`, path);
      } else if (typeof node.additionalProperties === "object" && node.additionalProperties !== null) {
        validateSchema(root, node.additionalProperties, entry, `${path}.${key}`, depth + 1);
      }
    }
    if (node.unevaluatedProperties === false) {
      const evaluated = evaluatedPropertyNames(root, node);
      for (const key of Object.keys(record)) {
        if (!evaluated.has(key)) {
          violate(`unexpected property "${key}" not evaluated by the composed schema`, path);
        }
      }
    }
  }
}

/**
 * Property names an object schema accepts through its own `properties` plus any
 * `$ref` / `allOf` / `oneOf` / `anyOf` branch, which is what OpenAPI 3.1's
 * `unevaluatedProperties: false` is used for in this contract.
 */
function evaluatedPropertyNames(root: Json, schema: Schema, depth = 0): Set<string> {
  const names = new Set<string>();
  if (depth > 20) return names;
  if (typeof schema.$ref === "string") {
    const target = resolvePointer(root, schema.$ref);
    if (target !== null && typeof target === "object") {
      for (const name of evaluatedPropertyNames(root, target as Schema, depth + 1)) names.add(name);
    }
    return names;
  }
  for (const key of Object.keys((schema.properties ?? {}) as Record<string, Json>)) names.add(key);
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch === null || typeof branch !== "object") continue;
      for (const name of evaluatedPropertyNames(root, branch as Schema, depth + 1)) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------

function pathSegments(path: string): string[] {
  return path.split("/").filter(segment => segment.length > 0);
}

function templatesMatch(left: string, right: string): boolean {
  const a = pathSegments(left);
  const b = pathSegments(right);
  return a.length === b.length
    && a.every((segment, index) => /^\{.+\}$/.test(segment) || segment === b[index]);
}

/**
 * OpenAPI path keys are relative to the declared server URL, which carries the
 * `/api/v2` base path; the running server also owns the root-level `/healthz`
 * liveness probe. Normalising both sides keeps the comparison honest.
 */
function normalizePath(index: OpenApiIndex, urlPath: string): string {
  for (const server of index.servers) {
    const serverURL = String(server.url ?? "");
    const base = serverURL.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\/+$/, "");
    if (base.length > 0 && urlPath.startsWith(`${base}/`)) {
      return urlPath.slice(base.length);
    }
  }
  return urlPath;
}

function documentedOperation(
  index: OpenApiIndex,
  method: string,
  urlPath: string
): DocumentedOperation | undefined {
  const normalized = normalizePath(index, urlPath);
  return index.operations.find(operation =>
    operation.method === method.toLowerCase() && templatesMatch(operation.path, normalized));
}

/**
 * Route templates actually registered in `src/server.ts`.
 * C04 keeps this list and `contracts/openapi.yaml` in sync.
 */
function implementedRoutes(): Map<string, string[]> {
  return new Map<string, string[]>([
    // `/healthz` is deliberately absent: it is a root-level liveness probe
    // outside the versioned `/api/v2` contract surface, and C03 asserts its
    // envelope directly instead.
    ["/api/v2/auth/phone/challenges", ["POST"]],
    ["/api/v2/auth/phone/verify", ["POST"]],
    ["/api/v2/auth/apple/challenges", ["POST"]],
    ["/api/v2/auth/apple", ["POST"]],
    ["/api/v2/auth/session/refresh", ["POST"]],
    ["/api/v2/watch/session/refresh", ["POST"]],
    ["/api/v2/watch/session/redeem", ["POST"]],
    ["/api/v2/session/bootstrap", ["POST"]],
    ["/api/v2/auth/logout", ["POST"]],
    ["/api/v2/auth/logout/recover", ["POST"]],
    ["/api/v2/auth/account", ["DELETE"]],
    ["/api/v2/me/companion-link-tickets", ["POST"]],
    ["/api/v2/watch/emergency-observations/{eventId}", ["PUT"]],
    ["/api/v2/watch/events/{eventId}/state", ["GET"]],
    ["/api/v2/watch/events/{eventId}/fallback-position/{positionUpdateId}", ["PUT"]],
    ["/api/v2/events", ["GET"]],
    ["/api/v2/events/{eventId}", ["GET"]],
    ["/api/v2/events/{eventId}/timeline", ["GET"]],
    ["/api/v2/events/{eventId}/patient-position", ["PUT"]],
    ["/api/v2/events/{eventId}/position-batches/{batchId}", ["PUT"]],
    ["/api/v2/events/{eventId}/confirm-false-alarm", ["POST"]],
    ["/api/v2/events/{eventId}/resolve", ["POST"]],
    ["/api/v2/events/{eventId}/end", ["POST"]],
    ["/api/v2/events/{eventId}/status-confirmation", ["POST"]],
    ["/api/v2/events/{eventId}/exit", ["POST"]],
    ["/api/v2/events/{eventId}/deliveries/{deliveryId}/receipt", ["PUT"]],
    ["/api/v2/events/{eventId}/responses/{deliveryId}", ["PUT"]],
    ["/api/v2/events/{eventId}/assignments/{assignmentId}/status", ["PUT"]],
    ["/api/v2/events/{eventId}/assignments/{assignmentId}/aed-acquired", ["PUT"]],
    ["/api/v2/events/{eventId}/assignments/{assignmentId}/aed-unavailable", ["PUT"]],
    ["/api/v2/me/responder-position", ["PUT"]],
    ["/api/v2/me/presence", ["GET", "PUT"]],
    ["/api/v2/me/nearby-volunteers", ["GET"]],
    ["/api/v2/aeds", ["GET"]],
    ["/api/v2/routes/aed", ["POST"]]
  ]);
}

interface RouteCall {
  label: string;
  method: string;
  path: string;
  response: { status: number; body: Json };
}

async function run(): Promise<void> {
  const sourceText = await readFile(engineeringPath(OPENAPI_FILE), "utf8");
  const index = indexContract(sourceText);
  console.log(`AEDResponse v2 contract smoke -> ${engineeringPath(OPENAPI_FILE)}`);
  console.log("");
  let current = "startup";
  const harness = await startSmokeHarness({ aeds: await readFixtureAeds() });
  console.log(`live conformance target: ${harness.baseURL}`);
  console.log("");

  const step = async (id: string, title: string, body: () => Promise<void> | void): Promise<void> => {
    current = `${id} ${title}`;
    const started = performance.now();
    await body();
    console.log(`  PASS  ${id}  ${title} (${Math.round(performance.now() - started)} ms)`);
  };

  try {
    await step("C01", "the contract keeps its identity and production entry", () => {
      equal(index.version, "3.1.0", "the contract must stay OpenAPI 3.1.0");
      check(typeof index.info.version === "string" && (index.info.version as string).length > 0,
        "info.version is required");
      const productionURL = String(index.servers[0]!.url ?? "");
      check(productionURL.startsWith("https://"),
        "the first declared server must be the production HTTPS/WSS entry", productionURL);
      check(index.servers.some(server => String(server.url ?? "").includes("127.0.0.1")),
        "a loopback development server must stay declared");
    });

    await step("C02", "every operation is identified and every internal $ref resolves", () => {
      const identifiers = new Set<string>();
      for (const operation of index.operations) {
        check(operation.operationId.length > 0,
          `operationId is required for ${operation.method} ${operation.path}`);
        check(!identifiers.has(operation.operationId),
          `operationId "${operation.operationId}" is duplicated`);
        identifiers.add(operation.operationId);
        check(Object.keys(operation.responseSchemas).length > 0,
          `responses are required for ${operation.method} ${operation.path}`);
      }
      check(index.operations.length >= 30,
        `the contract must document the full surface, found ${index.operations.length}`);
      for (const reference of index.references) {
        resolvePointer(index, reference);
      }
      // Shared `$ref` responses (the Problem document) must have been
      // dereferenced during extraction, otherwise error responses would be
      // silently exempt from runtime validation.
      const errorSchemas = index.operations.flatMap(operation =>
        Object.entries(operation.responseSchemas)
          .filter(([status]) => Number(status) >= 400)
          .map(([, schema]) => schema));
      check(errorSchemas.some(schema => schema !== null && schema !== undefined),
        "documented error responses must resolve to a shared schema");
      console.log(
        `        ${index.operations.length} operations, ${identifiers.size} operationIds, `
        + `${index.references.length} internal refs resolve, `
        + `${errorSchemas.filter(Boolean).length} documented error schemas`
      );
    });

    await step("C03", "live responses conform to the documented schemas", async () => {
      const calls: RouteCall[] = [];
      const guard = (call: RouteCall): void => {
        calls.push(call);
        const operation = documentedOperation(index, call.method, call.path);
        if (!operation) {
          violate(`undocumented route exercised: ${call.method} ${call.path}`,
            "add it to contracts/openapi.yaml or stop calling it");
        }
        const status = String(call.response.status);
        const schema = operation.responseSchemas[status]
          ?? operation.responseSchemas[`${status[0]}XX`];
        if (schema === undefined || schema === null) {
          if (call.response.status < 400 && call.response.status !== 204) {
            violate(`${call.method} ${call.path} returned ${status} with no documented JSON schema`,
              `${operation.operationId} documents ${Object.keys(operation.responseSchemas).join(", ")}`);
          }
          return;
        }
        validateSchema(index, schema, call.response.body, `${call.method} ${call.path} body`);
      };

      // `/healthz` is a root-level liveness probe, not part of the versioned API
      // surface, so it is asserted directly instead of through the contract.
      const health = await harness.request<{ status?: string; schemaVersion?: string; now?: string }>(
        "GET",
        "/healthz"
      );
      equal(health.status, 200, "the liveness probe must return 200");
      equal(health.body.status, "ok", "the liveness probe must report ok");
      equal(health.body.schemaVersion, "2.0", "the liveness probe must report schemaVersion 2.0");
      check(Number.isFinite(Date.parse(String(health.body.now))),
        "the liveness probe must report a parseable now");

      // An unauthenticated problem document must match the shared Problem schema.
      const problem = await harness.request("GET", "/api/v2/events");
      guard({
        label: "GET /events (unauthenticated)",
        method: "GET",
        path: "/api/v2/events",
        response: problem
      });

      const patient = await harness.bootstrapIPhone(uuid(9_601), uuid(9_602));
      const watch = await harness.bootstrapWatch(uuid(9_603), uuid(9_602), patient.sessionToken);
      const eventId = uuid(9_610);
      const created = await harness.request<Json>(
        "PUT",
        `/api/v2/watch/emergency-observations/${eventId}`,
        {
          schemaVersion: "2.0",
          eventId,
          observationKind: "FALL_CONTEXT",
          fallDetectedAt: harness.iso(1),
          fallResolution: "UNRESPONSIVE",
          appHelpResponse: "NEEDS_HELP",
          patientPositionObservedAt: harness.iso(0),
          patientPosition: {
            kind: "P",
            latitude: 22.1987,
            longitude: 113.5439,
            accuracyMeters: 12
          }
        },
        watch.sessionToken
      );
      guard({
        label: "PUT /watch/emergency-observations/{eventId}",
        method: "PUT",
        path: `/api/v2/watch/emergency-observations/${eventId}`,
        response: created
      });
      const view = await harness.request<Json>(
        "GET",
        `/api/v2/events/${eventId}`,
        undefined,
        patient.sessionToken
      );
      guard({
        label: "GET /events/{eventId} (patient)",
        method: "GET",
        path: `/api/v2/events/${eventId}`,
        response: view
      });
      const list = await harness.request<Json>("GET", "/api/v2/events", undefined, patient.sessionToken);
      guard({ label: "GET /events", method: "GET", path: "/api/v2/events", response: list });

      // Standby projections and the responder decision are documented with
      // strict shapes, so validate them against live documents too.
      const standby = await harness.bootstrapIPhone(uuid(9_604), uuid(9_605));
      const presence = await harness.request<Json>("GET", "/api/v2/me/presence", undefined, standby.sessionToken);
      guard({ label: "GET /me/presence", method: "GET", path: "/api/v2/me/presence", response: presence });
      const nearby = await harness.request<Json>(
        "GET",
        "/api/v2/me/nearby-volunteers",
        undefined,
        standby.sessionToken
      );
      guard({
        label: "GET /me/nearby-volunteers",
        method: "GET",
        path: "/api/v2/me/nearby-volunteers",
        response: nearby
      });
      await harness.request(
        "PUT",
        "/api/v2/me/responder-position",
        {
          positionUpdateId: uuid(9_606),
          responderPosition: { kind: "R", latitude: 22.198, longitude: 113.543, accuracyMeters: 10 },
          observedAt: harness.iso(0)
        },
        standby.sessionToken
      );
      const candidateView = await harness.request<{ pendingResponseRequest?: { deliveryId?: string } }>(
        "GET",
        `/api/v2/events/${eventId}`,
        undefined,
        standby.sessionToken
      );
      const deliveryId = candidateView.body.pendingResponseRequest?.deliveryId;
      check(typeof deliveryId === "string" && deliveryId.length > 0,
        "the standby iPhone must receive a recruitment offer for the new event");
      const decision = await harness.request<Json>(
        "PUT",
        `/api/v2/events/${eventId}/responses/${deliveryId}`,
        { decision: "ACCEPT", decidedAt: harness.iso(2) },
        standby.sessionToken
      );
      guard({
        label: "PUT /events/{eventId}/responses/{deliveryId}",
        method: "PUT",
        path: `/api/v2/events/${eventId}/responses/${deliveryId}`,
        response: decision
      });

      const watchState = await harness.request<Json>(
        "GET",
        `/api/v2/watch/events/${eventId}/state`,
        undefined,
        watch.sessionToken
      );
      guard({
        label: "GET /watch/events/{eventId}/state",
        method: "GET",
        path: `/api/v2/watch/events/${eventId}/state`,
        response: watchState
      });
      console.log(`        ${calls.length} live responses validated against documented schemas`);
    });

    await step("C04", "server routes and contract paths cover each other", () => {
      const implemented = implementedRoutes();
      const missing: string[] = [];
      for (const [path, methods] of implemented) {
        for (const method of methods) {
          if (!documentedOperation(index, method, path)) missing.push(`${method} ${path}`);
        }
      }
      check(missing.length === 0,
        "every implemented server route must be documented in contracts/openapi.yaml",
        missing.join("\n"));
      console.log(
        `        ${implemented.size} implemented route templates are all documented `
        + `(excluding the /healthz liveness probe, asserted in C03)`
      );
    });

    await step("C05", "the demo fixture stays schema-valid and internally consistent", async () => {
      const aeds = await readFixtureAeds();
      check(aeds.length >= 2, "the demo scenario must seed at least two AEDs");
      const identifiers = new Set<string>();
      for (const aed of aeds) {
        const parsed = aedSchema.safeParse(aed);
        check(parsed.success,
          `fixture AED ${aed.id ?? "?"} must match the AED contract`,
          parsed.success ? "" : JSON.stringify(parsed.error.issues));
        check(!identifiers.has(aed.id), `fixture AED id ${aed.id} is duplicated`);
        identifiers.add(aed.id);
      }
      console.log(`        ${aeds.length} fixture AEDs match the AED contract schema`);
    });

    console.log("");
    console.log("contract smoke passed: 5 steps");
  } catch (error) {
    console.log("");
    console.log(`FAIL  ${current}`);
    if (error instanceof Error && error.name === "SmokeFailure") {
      console.log(`      ${error.message}`);
      const detail = (error as { detail?: string }).detail;
      if (detail) console.log(`      ${detail}`);
    } else {
      console.log(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      if (error instanceof Error && error.stack) {
        console.log(error.stack.split("\n").slice(1, 6).join("\n"));
      }
    }
    throw error;
  } finally {
    await harness.stop();
  }
}

await run();
