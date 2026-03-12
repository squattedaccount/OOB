/**
 * Table output formatter — renders arrays of objects as aligned columns.
 * Falls back to key-value format for non-array data.
 */

export function formatTable(data: unknown): string {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
    return formatArrayAsTable(data as Record<string, unknown>[]);
  }

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return formatObjectAsTable(data as Record<string, unknown>);
  }

  return String(data);
}

function formatArrayAsTable(rows: Record<string, unknown>[]): string {
  // Collect all unique keys across all rows
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keys.add(key);
    }
  }
  const columns = [...keys];

  // Calculate column widths
  const widths = new Map<string, number>();
  for (const col of columns) {
    widths.set(col, col.length);
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = cellValue(row[col]);
      const w = widths.get(col) ?? 0;
      if (val.length > w) {
        widths.set(col, Math.min(val.length, 60));
      }
    }
  }

  // Build header
  const header = columns.map((col) => padRight(col, widths.get(col) ?? col.length)).join("  ");
  const separator = columns.map((col) => "─".repeat(widths.get(col) ?? col.length)).join("──");

  // Build rows
  const lines = [header, separator];
  for (const row of rows) {
    const line = columns
      .map((col) => padRight(truncate(cellValue(row[col]), 60), widths.get(col) ?? 0))
      .join("  ");
    lines.push(line);
  }

  return lines.join("\n");
}

function formatObjectAsTable(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "(empty)";

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([key, value]) => {
      const val = typeof value === "object" && value !== null ? JSON.stringify(value) : cellValue(value);
      return `${padRight(key, maxKeyLen)}  ${val}`;
    })
    .join("\n");
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
