import type { FieldSchema } from "./field-schema.js";
import { PRODUCT_FIELD_SCHEMA } from "./field-schema.js";

export type ParseFieldsResult =
  | { ok: true; paths: string[] | null }
  | { ok: false; message: string };

const MAX_FIELD_PATHS = 32;

/** Comma-separated dotted paths. Empty / omitted means no projection. */
export function parseFields(
  raw: string | undefined,
  schema: FieldSchema = PRODUCT_FIELD_SCHEMA,
): ParseFieldsResult {
  if (raw === undefined) {
    return { ok: true, paths: null };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, paths: null };
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const token of trimmed.split(",")) {
    const path = token.trim();
    if (path === "") {
      continue;
    }
    if (!isSafePath(path)) {
      return {
        ok: false,
        message: `Unknown or invalid fields path '${path}'.`,
      };
    }
    if (!isAllowedPath(path, schema)) {
      return {
        ok: false,
        message: `Unknown or invalid fields path '${path}'.`,
      };
    }
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }

  if (paths.length === 0) {
    return {
      ok: false,
      message: "fields must list one or more dotted paths.",
    };
  }
  if (paths.length > MAX_FIELD_PATHS) {
    return {
      ok: false,
      message: `fields cannot list more than ${MAX_FIELD_PATHS} paths.`,
    };
  }
  return { ok: true, paths: collapseChildPaths(paths) };
}

export function projectFields<T>(data: T, paths: string[]): Record<string, unknown> {
  if (!isRecord(data)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    assignPath(out, data, path.split("."));
  }
  return out;
}

function isSafePath(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(path);
}

function isAllowedPath(path: string, schema: FieldSchema): boolean {
  const parts = path.split(".");
  let node: FieldSchema | true | "*" = schema;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) {
      return false;
    }
    if (node === true) {
      return false;
    }
    if (node === "*") {
      return true;
    }
    const next: FieldSchema | true | "*" | undefined = node[part];
    if (next === undefined) {
      return false;
    }
    if (i === parts.length - 1) {
      return true;
    }
    node = next;
  }
  return false;
}

function collapseChildPaths(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const path of sorted) {
    const covered = kept.some(
      (parent) => path === parent || path.startsWith(`${parent}.`),
    );
    if (!covered) {
      kept.push(path);
    }
  }
  return kept;
}

function assignPath(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  parts: string[],
): void {
  const head = parts[0];
  if (head === undefined) {
    return;
  }
  const srcVal = source[head];
  if (parts.length === 1) {
    out[head] = cloneJson(srcVal);
    return;
  }
  const rest = parts.slice(1);
  if (Array.isArray(srcVal)) {
    const existing = out[head];
    const target: unknown[] = Array.isArray(existing)
      ? existing
      : srcVal.map((item) => (isRecord(item) ? {} : cloneJson(item)));
    srcVal.forEach((item, index) => {
      if (!isRecord(item)) {
        target[index] = cloneJson(item);
        return;
      }
      const slot = target[index];
      const child = isRecord(slot) ? slot : {};
      assignPath(child, item, rest);
      target[index] = child;
    });
    out[head] = target;
    return;
  }
  if (!isRecord(srcVal)) {
    out[head] = cloneJson(srcVal);
    return;
  }
  const existing = out[head];
  const child = isRecord(existing) ? existing : {};
  assignPath(child, srcVal, rest);
  out[head] = child;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
