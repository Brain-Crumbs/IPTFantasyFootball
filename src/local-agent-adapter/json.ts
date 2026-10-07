/** A bounded, lossless JSON boundary shared by hashing, persistence and validation. */
export const MAX_LOCAL_AGENT_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_AGENT_JSON_DEPTH = 64;
const MAX_NODES = 100000;

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encode = (text: string): string => {
    bytes += new TextEncoder().encode(text).length;
    if (bytes > MAX_LOCAL_AGENT_JSON_BYTES) throw new Error("JSON exceeds the 4 MiB limit.");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > MAX_NODES || depth > MAX_LOCAL_AGENT_JSON_DEPTH) throw new Error("JSON exceeds the depth/node limit.");
    if (item === null) return encode("null");
    if (typeof item === "string") {
      if (item.length > MAX_LOCAL_AGENT_JSON_BYTES) throw new Error("JSON exceeds the 4 MiB limit.");
      return encode(JSON.stringify(item));
    }
    if (typeof item === "boolean") return encode(String(item));
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return encode(String(item));
    if (typeof item !== "object" || item === null) throw new Error("Only lossless JSON values are accepted (no undefined, functions, bigint, symbols, nonfinite numbers or negative zero).");
    if (ancestors.has(item)) throw new Error("JSON must not contain cycles.");
    const isArray = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (isArray ? Array.prototype : Object.prototype) && !(Object.getPrototypeOf(item) === null && !isArray)) {
      throw new Error("JSON must contain only plain objects and arrays.");
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== "string")) throw new Error("JSON must not contain symbol keys.");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (isArray && key === "length") continue;
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("JSON must not contain hidden properties or accessors.");
    }
    ancestors.add(item);
    let result: string;
    if (isArray) {
      if (keys.length !== item.length + 1) throw new Error("JSON arrays must be dense and must not contain extra properties.");
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new Error("JSON arrays must be dense.");
        values.push(visit(descriptors[String(i)]!.value, depth + 1));
      }
      encode("[" + ",".repeat(Math.max(0, values.length - 1)) + "]");
      result = `[${values.join(",")}]`;
    } else {
      const entries = (keys as string[]).sort().map(key => `${encode(JSON.stringify(key))}:${visit(descriptors[key]!.value, depth + 1)}`);
      encode("{" + ":".repeat(entries.length) + ",".repeat(Math.max(0, entries.length - 1)) + "}");
      result = `{${entries.join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
