// A question an MCP server asks the person (MCP "elicitation"), as Claude Code passes it to a chat. Seen in Claude Code
// 2.1.331 headless stream-json: it arrives on stdout as
//   {"type":"control_request","request_id":R,"request":{"subtype":"elicitation","mcp_server_name","message",
//    "mode":"form"|"url","url","elicitation_id","requested_schema":{"type":"object","properties",…,"required"},
//    "property_order":[names],"title","display_name","description"}}
// and is answered on stdin with {"type":"control_response","response":{"subtype":"success","request_id":R,
// "response":{"action":"accept"|"decline"|"cancel","content":{name: value}}}} (claude-lines.mjs elicitLine).
//
// Everything in it comes from the MCP server, so it is data: shown as plain text, never Markdown, never a link but
// one http(s) address the person opens himself. Only the person answers it: no mode, rule, Hands-off or Tia does
// (asks.mjs answerMcp refuses any answer that is not his own fields; feature.mjs refuses her door). An answer is held
// against the fields the server asked for, here, before it goes back.

const FIELDS_MAX = 20;
const OPTIONS_MAX = 50;
const TEXT_MAX = 4000;
// Escape sequences, control characters but the line break and tab, and the marks that turn the writing direction
// (a sentence could be made to read as another one).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩‎‏]/g;

/** A server's text for the page: plain, at most `max` characters. */
export const serverText = (s, max = TEXT_MAX) => (typeof s === 'string' ? s.replace(ANSI, '').replace(CONTROL, '').replace(/\t/g, ' ').trim().slice(0, max) : '');
const oneLine = (s, max) => serverText(s, max).replace(/\s+/g, ' ');

/** The address a URL question asks the person to open, when it is a plain http(s) one; else null. */
export function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

function optionsOf(p) {
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    return p.enum.slice(0, OPTIONS_MAX).map((v, i) => (typeof v === 'string' ? { value: v.slice(0, 500), label: oneLine(names[i], 200) || oneLine(v, 200) } : null)).filter(Boolean);
  }
  const list = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
  if (!list) return null;
  return list.slice(0, OPTIONS_MAX).map((o) => (o && typeof o.const === 'string' ? { value: o.const.slice(0, 500), label: oneLine(o.title, 200) || oneLine(o.const, 200) } : null)).filter(Boolean);
}

/** One field of the server's form, in the page's terms. kind: text, number, yesno, choice, choices or unknown. */
function fieldOf(name, p, required) {
  const base = { name, label: oneLine(p && p.title, 200) || oneLine(name, 200), hint: serverText(p && p.description, 500), required };
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...base, kind: 'unknown', type: '' };
  if (p.type === 'string') {
    const options = optionsOf(p);
    if (options && options.length) return { ...base, kind: 'choice', options, default: options.some((o) => o.value === p.default) ? p.default : null };
    const max = Math.min(num(p.maxLength) ?? TEXT_MAX, TEXT_MAX);
    return { ...base, kind: 'text', format: FORMATS.has(p.format) ? p.format : null, minLength: num(p.minLength), maxLength: max, default: typeof p.default === 'string' ? p.default.slice(0, max) : null };
  }
  if (p.type === 'number' || p.type === 'integer') {
    return { ...base, kind: 'number', integer: p.type === 'integer', minimum: num(p.minimum), maximum: num(p.maximum), default: num(p.default) };
  }
  if (p.type === 'boolean') return { ...base, kind: 'yesno', default: typeof p.default === 'boolean' ? p.default : null };
  if (p.type === 'array' && p.items && typeof p.items === 'object') {
    const options = optionsOf(p.items);
    if (options && options.length) {
      const def = Array.isArray(p.default) ? p.default.filter((v) => options.some((o) => o.value === v)) : [];
      return { ...base, kind: 'choices', options, minItems: num(p.minItems), maxItems: num(p.maxItems), default: def };
    }
  }
  return { ...base, kind: 'unknown', type: typeof p.type === 'string' ? p.type.slice(0, 40) : '' };
}

/** The server's form (requested_schema, in property_order where it gives one) as fields, at most 20. */
export function mcpFields(schema, order) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required.filter((n) => typeof n === 'string') : []);
  const names = [...new Set([...(Array.isArray(order) ? order.filter((n) => typeof n === 'string' && Object.hasOwn(props, n)) : []), ...Object.keys(props)])];
  // "__proto__" cannot be a key of the answer as a plain object: such a field is left out.
  return names.filter((n) => n.length <= 100 && n !== '__proto__').slice(0, FIELDS_MAX).map((n) => fieldOf(n, props[n], required.has(n)));
}

/** The chat's ask event for Claude Code's elicitation request `r` (its id `request`). */
export function mcpAsk(request, r) {
  const server = oneLine(r.mcp_server_name, 80) || 'an MCP server';
  const mode = r.mode === 'url' ? 'url' : 'form';
  return {
    kind: 'ask', request, type: 'mcp', tool: 'MCP', server, title: `A question from the MCP server ${server}`,
    message: serverText(r.message), mode, url: mode === 'url' ? safeUrl(r.url) : null,
    fields: mode === 'form' ? mcpFields(r.requested_schema, r.property_order) : [],
    toolId: null, description: '', input: {}, full: {}, interactive: true, subject: '', known: false,
    owner: 'question', why: '', grant: null, settled: false, agent: null,
  };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkText(f, v) {
  if (typeof v !== 'string') throw bad(`${f.label}: write it as text`);
  if (v.length > f.maxLength) throw bad(`${f.label}: at most ${f.maxLength} characters`);
  if (f.minLength !== null && v.length < f.minLength) throw bad(`${f.label}: at least ${f.minLength} characters`);
  if (f.format === 'email' && !EMAIL.test(v)) throw bad(`${f.label}: an e-mail address`);
  if (f.format === 'uri' && !safeUrl(v)) throw bad(`${f.label}: a web address`);
  if (f.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${f.label}: a date`);
  if (f.format === 'date-time' && !Number.isFinite(Date.parse(v))) throw bad(`${f.label}: a date and time`);
}

/**
 * The person's answers `content` held against `fields` (mcpFields): every name one of the fields, each value of its
 * kind and inside its bounds, every required one there. → the content to send back; throws a 400 with one sentence.
 */
export function mcpContent(fields, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw bad('The answers are one value per field');
  for (const k of Object.keys(content)) if (!fields.some((f) => f.name === k)) throw bad('An answer names a field the server did not ask for');
  const unknown = fields.find((f) => f.kind === 'unknown');
  if (unknown) throw bad(`${unknown.label} cannot be filled in here: decline the question`);
  const out = {};
  for (const f of fields) {
    const v = Object.hasOwn(content, f.name) ? content[f.name] : undefined; // never an inherited toString or constructor
    const none = v === undefined || v === null || v === '' || (f.kind === 'choices' && Array.isArray(v) && !v.length);
    if (none) {
      if (f.required) throw bad(`${f.label} is needed`);
      continue;
    }
    if (f.kind === 'text') checkText(f, v);
    else if (f.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (f.integer && !Number.isInteger(v))) throw bad(`${f.label}: ${f.integer ? 'a whole number' : 'a number'}`);
      if ((f.minimum !== null && v < f.minimum) || (f.maximum !== null && v > f.maximum)) throw bad(`${f.label}: from ${f.minimum ?? 'any'} to ${f.maximum ?? 'any'}`);
    } else if (f.kind === 'yesno') {
      if (typeof v !== 'boolean') throw bad(`${f.label}: yes or no`);
    } else if (f.kind === 'choice') {
      if (!f.options.some((o) => o.value === v)) throw bad(`${f.label}: one of its choices`);
    } else if (f.kind === 'choices') {
      if (!Array.isArray(v) || new Set(v).size !== v.length || v.some((x) => !f.options.some((o) => o.value === x))) throw bad(`${f.label}: some of its choices`);
      if ((f.minItems !== null && v.length < f.minItems) || (f.maxItems !== null && v.length > f.maxItems)) throw bad(`${f.label}: from ${f.minItems ?? 0} to ${f.maxItems ?? 'any'} choices`);
    }
    out[f.name] = v;
  }
  return out;
}
