import { canonicalJson } from "./json.js";

type Schema = Record<string, unknown>;
const object = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const KEYWORDS = new Set(["$schema", "$id", "title", "description", "$defs", "$ref", "type", "const", "enum", "minLength", "pattern", "format", "properties", "required", "additionalProperties", "items", "oneOf", "allOf", "if", "then"]);

/** Only the authored schemas' vocabulary is supported; new keywords fail closed. */
export function assertSupportedSchema(schema: Schema): void {
  if (!object(schema)) throw new Error("Local-agent schema must be an object.");
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`Unsupported local-agent schema keyword '${key}'.`);
    if (key === "type" && (typeof value !== "string" || !["object", "array", "string", "boolean", "number", "null"].includes(value))) throw new Error("Unsupported schema type.");
    if (key === "additionalProperties" && typeof value !== "boolean") throw new Error("Only boolean additionalProperties is supported.");
    if (key === "required" && (!Array.isArray(value) || value.some(v => typeof v !== "string"))) throw new Error("Invalid required schema list.");
    if (key === "enum" && (!Array.isArray(value) || value.length === 0)) throw new Error("Invalid schema enum.");
    if (key === "minLength" && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) throw new Error("Invalid schema minLength.");
    if (key === "pattern") { if (typeof value !== "string") throw new Error("Invalid schema pattern."); new RegExp(value, "u"); }
    if (["$defs", "properties", "items", "if", "then"].includes(key) && !object(value)) throw new Error("Unsupported schema fragment.");
    if (["oneOf", "allOf"].includes(key) && (!Array.isArray(value) || value.length === 0)) throw new Error("Invalid schema alternatives.");
    if (["$defs", "properties"].includes(key) && object(value)) {
      for (const sub of Object.values(value)) { if (!object(sub)) throw new Error("Invalid schema."); assertSupportedSchema(sub); }
    }
    if (["items", "if", "then"].includes(key) && object(value)) assertSupportedSchema(value);
    if (["oneOf", "allOf"].includes(key) && Array.isArray(value)) {
      for (const sub of value) { if (!object(sub)) throw new Error("Invalid schema."); assertSupportedSchema(sub); }
    }
    if (key === "format" && value !== "date-time") throw new Error("Unsupported schema format.");
    if (key === "$ref" && (typeof value !== "string" || !value.startsWith("#/$defs/"))) throw new Error("Only local schema references are supported.");
  }
}

/** Reads the exact authored schema rather than maintaining a second shape validator. */
export function schemaErrors(value: unknown, schema: Schema, root: Schema = schema, path = "$"): string[] {
  const errors: string[] = [];
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.slice(8);
    const sub = object(root.$defs) && Object.hasOwn(root.$defs, name) ? root.$defs[name] : undefined;
    if (!object(sub)) throw new Error(`Unresolved schema reference ${schema.$ref}.`);
    errors.push(...schemaErrors(value, sub, root, path));
  }
  if (Object.hasOwn(schema, "const") && canonicalJson(value) !== canonicalJson(schema.const)) errors.push(`${path}: wrong constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some(v => canonicalJson(v) === canonicalJson(value))) errors.push(`${path}: not an allowed value`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (typeof schema.type === "string" && type !== schema.type) return [...errors, `${path}: expected ${schema.type}`];
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: invalid string`);
    if (schema.format === "date-time" && !validDateTime(value)) errors.push(`${path}: invalid RFC3339 date-time`);
  }
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key) && object(properties[key])) errors.push(...schemaErrors(value[key], properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
    }
  }
  if (Array.isArray(value) && object(schema.items)) value.forEach((v, i) => errors.push(...schemaErrors(v, schema.items as Schema, root, `${path}[${i}]`)));
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(s => object(s) && schemaErrors(value, s, root, path).length === 0).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one allowed result shape`);
  }
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) {
    if (object(sub)) errors.push(...schemaErrors(value, sub, root, path));
  }
  if (object(schema.if) && object(schema.then) && schemaErrors(value, schema.if, root, path).length === 0) errors.push(...schemaErrors(value, schema.then, root, path));
  return errors;
}

function validDateTime(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! && hour! <= 23 && minute! <= 59 && second! <= 59 && (Number.isNaN(offsetHour) || offsetHour! <= 23) && (Number.isNaN(offsetMinute) || offsetMinute! <= 59) && !Number.isNaN(Date.parse(text));
}
