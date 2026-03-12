// TOON (Token-Oriented Object Notation)
// Compact format optimized for LLM context windows.
// Uses ~40% fewer tokens than JSON for typical API responses.
// Implemented from scratch based on TOON format principles.

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value === "true" || value === "false" || value === "null" || value === "-") return true;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return true;
  if (/[,\n\r\t{}[\]:"]/.test(value)) return true;
  return false;
}

function encodePrimitive(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    return needsQuoting(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

function isPrimitiveArray(arr: unknown[]): boolean {
  return arr.every(isPrimitive);
}

function isUniformObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  if (arr.some(item => isPrimitive(item) || Array.isArray(item))) return false;
  const keys0 = Object.keys(arr[0] as object).sort().join(",");
  return arr.every(item => Object.keys(item as object).sort().join(",") === keys0);
}

function encodeObject(obj: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";

  const pad = "  ".repeat(depth);
  const lines: string[] = [];

  for (const [key, val] of entries) {
    if (isPrimitive(val)) {
      lines.push(`${pad}${key}: ${encodePrimitive(val)}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (isPrimitiveArray(val)) {
        lines.push(`${pad}${key}: ${val.map(encodePrimitive).join(",")}`);
      } else if (isUniformObjectArray(val)) {
        const keys = Object.keys(val[0] as object);
        lines.push(`${pad}${key} [${val.length}]{${keys.join(",")}}:`);
        const innerPad = "  ".repeat(depth + 1);
        for (const item of val) {
          const row = keys.map(k => encodePrimitive((item as Record<string, unknown>)[k])).join(",");
          lines.push(`${innerPad}${row}`);
        }
      } else {
        lines.push(`${pad}${key}:`);
        lines.push(encodeArray(val, depth + 1));
      }
    } else {
      lines.push(`${pad}${key}:`);
      lines.push(encodeObject(val as Record<string, unknown>, depth + 1));
    }
  }

  return lines.join("\n");
}

function encodeArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return "[]";

  const pad = "  ".repeat(depth);

  if (isPrimitiveArray(arr)) {
    return `${pad}${arr.map(encodePrimitive).join(",")}`;
  }

  if (isUniformObjectArray(arr)) {
    const keys = Object.keys(arr[0] as object);
    const lines: string[] = [];
    lines.push(`${pad}[${arr.length}]{${keys.join(",")}}:`);
    const innerPad = "  ".repeat(depth + 1);
    for (const item of arr) {
      const row = keys.map(k => encodePrimitive((item as Record<string, unknown>)[k])).join(",");
      lines.push(`${innerPad}${row}`);
    }
    return lines.join("\n");
  }

  const items = arr.map(item => {
    if (isPrimitive(item)) {
      return `${pad}- ${encodePrimitive(item)}`;
    }
    if (Array.isArray(item)) {
      return `${pad}- ${encodeArray(item, depth + 1)}`;
    }
    const inner = encodeObject(item as Record<string, unknown>, depth + 1);
    return `${pad}-\n${inner}`;
  });
  return items.join("\n");
}

export function formatToon(value: unknown): string {
  if (isPrimitive(value)) {
    return encodePrimitive(value);
  }
  if (Array.isArray(value)) {
    return encodeArray(value, 0);
  }
  return encodeObject(value as Record<string, unknown>, 0);
}
