// The way out of an error: a server sentence that says "turn it on in Settings → New sessions → Coding tools" sends a `code` beside
// its error, and this one table turns that code into a button to the place (lib.js wayButton, used by a toast of an
// error and by errorBox). One table for the whole page, never a list per page. The label is the place's own heading;
// `?show=<id>` brings a switch or field into view (showpart.js). A way only opens the place: nothing is pressed,
// turned on or filled in, he does that himself.
//
// perComputer: false for a place that is this dashboard's own (Computers), not the computer the error came from.

export const WAYS = {
  // src/machines/relay.mjs: another computer no longer lets this dashboard in (its token was revoked there). What
  // lets it in again is adding it again here, so the button opens that step, as its sentence says.
  // Its button says the step itself ("Add a computer"), with no arrow in a button's words.
  'computer-not-allowed': { label: 'Computers → Add a computer', button: 'Add a computer', href: '#/computers/add', perComputer: false },
  // No provider yet, or one that does not serve the coding tool (src/profiles.mjs, the starts of sessions and work).
  'no-provider': { label: 'Providers', href: '#/providers' },
  'provider-not-served': { label: 'Providers', href: '#/providers' },
  // A coding tool that is off, not installed, or whose server did not start (src/codetools, src/chat/engines).
  'tool-off': { label: 'Coding tools', href: '#/settings/new-sessions?show=coding-tools' },
  'tool-not-installed': { label: 'Coding tools', href: '#/settings/new-sessions?show=coding-tools' },
  'tool-not-started': { label: 'Coding tools', href: '#/settings/new-sessions?show=coding-tools' },
  // A coding tool to install (src/codetools/start.mjs: "Install it in Settings → New sessions → Coding tools"): its Install button is there.
  'tool-install': { label: 'Coding tools', href: '#/settings/new-sessions?show=coding-tools' },
  // Settings switches and fields a refusal names.
  'bypass-off': { label: 'New-session defaults', href: '#/settings/new-sessions?show=bypass' },
  // Bypass permissions refused because Hoprig runs as root (src/bypassgate.mjs ROOT_BYPASS_LINE): the page that
  // explains it and moves Hoprig to an ordinary user. It opens the page only; the move is his own press there.
  'root-bypass': { label: 'Runs as root', href: '#/settings/root' },
  'learn-off': { label: 'Learn skills', href: '#/skills/learned' },
  'limiter-changed': { label: 'Go live', href: '#/work/golive?show=sp-limiter' },
  'no-password': { label: 'Security and sign-in', href: '#/settings/security?show=password' },
  'notify-address': { label: 'Notifications', href: '#/settings/notifications?show=page-address' },
  'updates-moved': { label: 'Updates', href: '#/settings/updates' },
  // Settings → Tia by its whole name: the sidebar's "Tia" is her chat, a different place. A button says it without
  // an arrow ("Open Tia's settings"), as every button of this table does; the sentences keep the place's name.
  'tia-cap': { label: 'Settings → Tia', button: "Open Tia's settings", href: '#/settings/tia' },
  // Tia is off (src/assistant/feature.mjs: "Turn Tia on first", and her call route's 403): Settings → Tia has the
  // switch, named in full like tia-cap, since "Open Tia" would promise her chat.
  'tia-off': { label: 'Settings → Tia', button: "Open Tia's settings", href: '#/settings/tia' },
  // Gateways (src/addons/localgateway.mjs, src/gateway/index.mjs).
  'gateway-not-confirmed': { label: 'Add-ons', href: '#/settings/addons' },
  'gateway-service': { label: 'Health', href: '#/computer/health' },
  'gateway-no-provider': { label: 'Providers', href: '#/providers?show=gateways' },
  'gateway-not-shared': { label: 'Providers', href: '#/providers?show=gateways' },
  // Work's place (src/work/place.mjs): a project that is gone (Work → Tasks → Work settings), or no AI brain yet (its page sets it up).
  'work-place-gone': { label: 'Work settings', button: "Open Work's settings", href: '#/work/tasks?show=work-place' },
  'no-workspace': { label: 'AI brain', href: '#/brain' },
  // An Accept of a plan that was interrupted and waits (src/work/planstore.mjs): Work's own page shows its record and Drop.
  'interrupted': { label: 'Work', href: '#/work' },
  // A planning tool's file that does not use his id yet (src/work/model.mjs): the field in Work → Tasks → Work settings.
  'owner-id': { label: 'Work settings', button: "Open Work's settings", href: '#/work/tasks?show=owner-id' },
  // The places the Operator's texts name (src/operator: item.mjs, decide-table.mjs, rules.mjs, reflex.mjs, decider.mjs).
  // "Tia decides → Change the limits" and a hold are on the Operator page.
  'operator-page': { label: 'Operator', href: '#/operator' },
  'decide-limits': { label: 'Operator', href: '#/operator' },
  'auto-mode': { label: 'Providers', href: '#/providers' },
  'tia-settings': { label: 'Settings → Tia', button: "Open Tia's settings", href: '#/settings/tia' },
  // A mission's why that names Work → Plans or Work → Team (src/mission/engine.mjs).
  'work-plans': { label: 'Plans', href: '#/work/plans' },
  'work-team': { label: 'Team', href: '#/work/team' },
};

/** The code an error (an ApiError, an Error with details, or a result { error, code }) carries, or null. */
export function codeOf(err) {
  if (!err || typeof err !== 'object') return null;
  const c = err.code || (err.data && err.data.code) || (err.details && err.details.code);
  return typeof c === 'string' ? c : null;
}

/** The way for an error's code: { label, href, perComputer } (a copy), or null for no code or one not in WAYS. */
export function wayOf(err) {
  const c = codeOf(err);
  return c && Object.hasOwn(WAYS, c) ? { perComputer: true, ...WAYS[c] } : null;
}
