// What an act takes, in the fewest words (find_acts): each input by name, its form, whether it is needed (*), and the allowed
// values where they are few. The row's tool of hers (the action tool, its action's own fields) is the truth where a tool reaches
// the row; else the row's own input schema; so what she is shown is what the check then holds her to.
import { describe } from './schema.mjs';

let TOOLS = null;
/** tools.mjs gives the tools by name once they are all made (this file cannot import them: they import it). */
export const useTools = (byName) => {
  TOOLS = byName;
};
export const toolDef = (name) => (TOOLS && TOOLS.get(name)) || null;

const line = (name, json, needed) => `${name}${needed ? '*' : ''}: ${describe(json)}`;

/** The action of a row's tool that the row does: the row's own, or "list" for a read row of an action tool (look sends it). */
export function actionOf(row, def) {
  const t = row.tool;
  if (t && t.action) return t.action;
  return def && def.actions && def.actions.list && row.facts && row.facts.reads ? 'list' : null;
}

/** The inputs of a row as one short text, or '' when it takes none. */
export function inputOf(row) {
  const t = row.tool && row.tool.name ? row.tool : null;
  const def = t ? toolDef(t.name) : null;
  if (def && def.actions) {
    const action = actionOf(row, def);
    const x = action && def.actions[action];
    if (!x) return `action*: ${Object.keys(def.actions).join('|')}`.slice(0, 300);
    const props = def.input.props || {};
    const need = x.need || [];
    const names = [...need, ...(x.allow || []).filter((k) => !need.includes(k))].filter((k) => props[k]);
    return [...names.map((k) => line(k, props[k].json, need.includes(k))), ...(x.how ? [x.how] : [])].join('; ').slice(0, 520);
  }
  if (t && t.name === 'hoprig_act' && def && def.acts && def.acts[t.action]) return (def.acts[t.action].needs || []).join('; ').slice(0, 300);
  const schema = row.input;
  if (schema && schema.properties && Object.keys(schema.properties).length) {
    const req = new Set(schema.required || []);
    return Object.entries(schema.properties).map(([k, j]) => line(k, j, req.has(k))).join('; ').slice(0, 520);
  }
  return '';
}
