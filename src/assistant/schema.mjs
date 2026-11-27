// A small schema language for the assistant's tool inputs. One definition gives both the JSON Schema that the
// model sees (tools/list) and the strict validator the dashboard runs on every call, so the two cannot drift.
//
// Why not zod: the inputs are flat and few, zod would be the first runtime dependency of the assistant, and its
// JSON Schema output would still need hand-tuning for a byte-stable tool list. This is ~150 lines with no
// dependency and is tested in test/assistant/schema.test.mjs.
//
// Every validator is strict: unknown keys are refused (a typo must not be silently dropped), types are never
// coerced, strings have a maximum length and no NUL. `ref(kind)` marks an id that must be one the assistant was
// shown earlier (see shown.mjs); the validator only collects those refs, the caller checks them.

export class SchemaError extends Error {
  constructor(path, message) {
    super(`${path || 'input'}: ${message}`);
    this.path = path;
  }
}

const join = (path, key) => (path ? `${path}.${key}` : key);

/**
 * A field's description as the model gets it: its first sentence, at most 120 characters (the model reads this once in
 * every request, so every extra word is paid on every call). The tool's own check says the rest when a value is wrong.
 */
export function brief(text, max = 120) {
  const first = String(text).split(/(?<=\.)\s/)[0];
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : first;
}

/** A string. o: { min = 1, max, pattern (RegExp), enum, desc, oneLine } */
export function str(o = {}) {
  const { min = 1, max = 500, pattern = null, desc = '', oneLine = false } = o;
  const json = { type: 'string' };
  if (desc) json.description = o.full ? desc : brief(desc);
  if (o.enum) json.enum = [...o.enum];
  else {
    // The defaults (1 and 500) are not said: the check above still holds them, and the model needs no hint for them.
    if (min !== 1) json.minLength = min;
    if (max !== 500) json.maxLength = max;
    if (pattern) json.pattern = pattern.source;
  }
  return {
    json,
    check(v, path) {
      if (typeof v !== 'string') throw new SchemaError(path, 'must be a string');
      if (o.enum) {
        if (!o.enum.includes(v)) throw new SchemaError(path, `must be one of: ${o.enum.join(', ')}`);
        return v;
      }
      if (v.includes('\0')) throw new SchemaError(path, 'must not contain NUL');
      if (v.length < min) throw new SchemaError(path, min === 1 ? 'must not be empty' : `must have at least ${min} characters`);
      if (v.length > max) throw new SchemaError(path, `must have at most ${max} characters`);
      if (oneLine && /[\r\n]/.test(v)) throw new SchemaError(path, 'must be one line');
      if (pattern && !pattern.test(v)) throw new SchemaError(path, 'has the wrong form');
      return v;
    },
  };
}

/** A whole number. o: { min, max, desc } */
export function int(o = {}) {
  const { min = 0, max = 2 ** 31 - 1, desc = '' } = o;
  const json = { type: 'integer' };
  if (min !== 0) json.minimum = min;
  if (max !== 2 ** 31 - 1) json.maximum = max;
  if (desc) json.description = brief(desc);
  return {
    json,
    check(v, path) {
      if (!Number.isInteger(v)) throw new SchemaError(path, 'must be a whole number');
      if (v < min || v > max) throw new SchemaError(path, `must be from ${min} to ${max}`);
      return v;
    },
  };
}

export function bool(o = {}) {
  const json = { type: 'boolean' };
  if (o.desc) json.description = brief(o.desc);
  return {
    json,
    check(v, path) {
      if (typeof v !== 'boolean') throw new SchemaError(path, 'must be true or false');
      return v;
    },
  };
}

/** A list. o: { min = 0, max, unique, desc } */
export function arr(item, o = {}) {
  const { min = 0, max = 20, unique = false, desc = '' } = o;
  const json = { type: 'array', items: item.json };
  if (min !== 0) json.minItems = min;
  if (max !== 20) json.maxItems = max;
  if (unique) json.uniqueItems = true;
  if (desc) json.description = brief(desc);
  return {
    json,
    check(v, path, refs) {
      if (!Array.isArray(v)) throw new SchemaError(path, 'must be a list');
      if (v.length < min || v.length > max) throw new SchemaError(path, `must have ${min} to ${max} items`);
      const out = v.map((x, i) => item.check(x, `${path}[${i}]`, refs));
      if (unique && new Set(out.map((x) => JSON.stringify(x))).size !== out.length) throw new SchemaError(path, 'must not repeat an item');
      return out;
    },
  };
}

/** Any JSON value (checked further by the tool itself). Used only where the type depends on another field. */
export function anyJson(o = {}) {
  const json = {};
  if (o.desc) json.description = brief(o.desc);
  return {
    json,
    check(v, path) {
      if (v === undefined) throw new SchemaError(path, 'is missing');
      let text;
      try {
        text = JSON.stringify(v);
      } catch {
        throw new SchemaError(path, 'must be plain JSON');
      }
      if (text.length > 16_000) throw new SchemaError(path, 'is too large');
      return JSON.parse(text);
    },
  };
}

/**
 * An id of something the assistant must have been shown by an earlier tool result (kind: "session", "process",
 * "conversation", "computer"). Collected into `refs`; shown.mjs decides.
 */
export function ref(kind, base) {
  return {
    json: base.json,
    kind,
    check(v, path, refs) {
      const out = base.check(v, path, refs);
      if (refs) refs.push({ kind, value: out, path });
      return out;
    },
  };
}

/** An object with known keys only. `required` lists the keys that must be there. */
export function obj(props, { required = [] } = {}) {
  const json = { type: 'object', properties: {}, additionalProperties: false };
  for (const [k, s] of Object.entries(props)) json.properties[k] = s.json;
  if (required.length) json.required = [...required];
  return {
    json,
    props,
    check(v, path, refs) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SchemaError(path, 'must be an object');
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(props, k)) throw new SchemaError(path, `unknown field "${k}" (allowed: ${Object.keys(props).join(', ') || 'none'})`);
      }
      const out = {};
      for (const k of required) if (v[k] === undefined) throw new SchemaError(join(path, k), 'is required');
      for (const [k, s] of Object.entries(props)) {
        if (v[k] === undefined) continue;
        out[k] = s.check(v[k], join(path, k), refs);
      }
      return out;
    },
  };
}

/** Validate `value` against `schema`. Returns { value, refs } or throws SchemaError. */
export function validate(schema, value) {
  const refs = [];
  const out = schema.check(value === undefined ? {} : value, '', refs);
  return { value: out, refs };
}
