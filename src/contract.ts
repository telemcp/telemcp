// Loads contract/door-contract.json (the single source of truth for tool names and input schemas)
// and validates tool inputs against it, so a malformed call gets a contract error, not a crash.

import { readFileSync } from "node:fs";
import { ToolError } from "./errors.js";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  pattern?: string;
  default?: unknown;
  [k: string]: unknown;
}

/** A tool as written in the contract file. */
interface RawTool {
  name: string;
  description: string;
  input: JsonSchema;
  output?: unknown;
}

/** A tool as this server uses it: the contract input schema, made strict at the top level. */
export interface ContractTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  output?: unknown;
}

export interface ContractChannel {
  server: string;
  recipient: JsonSchema;
  tools: RawTool[];
  error_codes?: Record<string, string>;
  notes?: string[];
}

/** The canonical door-contract layout shared by every door server. */
export interface DoorContract {
  contract: string;
  version: string;
  rules: string[];
  objects: Record<string, unknown>;
  shared_tools: RawTool[];
  channels: Record<string, ContractChannel>;
  error_codes: Record<string, string>;
}

export function loadContract(): DoorContract {
  const url = new URL("../contract/door-contract.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as DoorContract;
}

/** Every error code a server on this channel may return: the shared codes plus the channel's own. */
export function channelErrorCodes(contract: DoorContract, channel: string): string[] {
  const ch = contract.channels[channel];
  if (!ch) throw new Error(`door contract has no channel ${channel}`);
  return [...Object.keys(contract.error_codes), ...Object.keys(ch.error_codes ?? {})];
}

// Unknown top-level fields are refused (invalid_input) so a typo never silently does something else.
function toTool(t: RawTool): ContractTool {
  return { name: t.name, description: t.description, inputSchema: { ...t.input, additionalProperties: false }, output: t.output };
}

/** Shared tools plus the channel's own, with send_message.to replaced by the channel's recipient schema. */
export function channelTools(contract: DoorContract, channel: string): ContractTool[] {
  const ch = contract.channels[channel];
  if (!ch) throw new Error(`door contract has no channel ${channel}`);
  const shared = contract.shared_tools.map((raw) => {
    const t = toTool(raw);
    if (t.name !== "send_message") return t;
    const props = { ...t.inputSchema.properties, to: { ...ch.recipient } };
    return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
  });
  return [...shared, ...ch.tools.map(toTool)];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

/** Validates the subset of JSON Schema the contract uses. Throws ToolError("invalid_input" | "invalid_recipient"). */
export function validate(schema: JsonSchema, value: unknown, path = "input"): void {
  const fail = (msg: string): never => {
    const code = path.startsWith("to") ? "invalid_recipient" : "invalid_input";
    throw new ToolError(code, `${path}: ${msg}`);
  };
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) fail(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    for (const r of schema.required ?? []) if (obj[r] === undefined) fail(`${r} is required`);
    if (schema.additionalProperties === false)
      for (const k of keys) if (!schema.properties?.[k]) fail(`unknown field ${k}`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties)
      fail(`needs ${schema.minProperties === 1 ? "one field" : schema.minProperties + " fields"}`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      fail(`must name exactly one recipient (one field); there is no bulk send`);
    for (const k of keys) {
      const sub = schema.properties?.[k];
      if (sub) validate(sub, obj[k], path === "input" ? k : `${path}.${k}`);
    }
  }
}

/** The input schema as advertised over MCP: the contract schema minus the non JSON Schema local_only marker. */
export function advertisedSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema, (k, v) => (k === "local_only" ? undefined : v)));
}
