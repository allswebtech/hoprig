// The public link as the add-on it was before it had a page of its own: the id "public-link" in GET /api/addons
// and its routes /api/addons/public-link/… . They map onto the one switch (linkswitch.mjs), so a hub that runs an
// older Hoprig, a profile whose PRERUN says `hoprig addons start public-link`, and the add-on list keep working for
// one release. New code uses /api/public-link (linkroutes.mjs) and `hoprig public`.
import { closeOpenedBy, customStep, readSwitch, settled, status, temporaryStep, turnOff, turnOn, attach, detach } from './linkswitch.mjs';
import { install, update } from './publiclink.mjs';

export const ID = 'public-link';

/** The old shape: the Temporary address as running/url, the Custom one under `fixed`. */
async function oldStatus() {
  const s = status();
  const on = (kind) => s.on && s.kind === kind;
  return {
    installed: s.installed,
    version: null,
    running: on('temporary') && s.state === 'on',
    url: on('temporary') && s.state === 'on' ? s.url : null,
    account: false,
    service: s.service,
    fixed: { ...s.custom, enabled: on('custom'), running: on('custom') && s.state !== 'off', connected: on('custom') && s.state === 'on', nextTryAt: on('custom') ? s.nextTryAt : null, error: on('custom') ? s.error : null },
    link: s,
  };
}

/** Turn on and wait for the answer, as the old start did. */
async function onAndWait(kind, by) {
  const r = await turnOn(kind, { by });
  if (!r.ok) return r;
  const s = await settled();
  return s.state === 'on' || (kind === 'custom' && s.on) ? { ok: true, url: s.url || (kind === 'custom' ? s.custom.url : null), already: false } : { ok: false, error: s.error || 'The public link did not start.' };
}

const offIf = async (kind) => (readSwitch().kind === kind ? turnOff() : { ok: true });

export const publicLink = {
  id: ID,
  title: 'Public link',
  summary: 'Open this dashboard from anywhere, without a server of your own: Settings → Public link.',
  homepage: 'https://github.com/allswebtech/hoprig/blob/main/docs/COMPUTERS.md#a-public-link-through-cloudflare',
  status: oldStatus,
  install,
  update,
  start: ({ by = null } = {}) => onAndWait('temporary', by),
  stop: () => offIf('temporary'),
  actions: {
    'fixed-sign-in': (b, o) => customStep('sign-in', b, o),
    'fixed-cancel': (b, o) => customStep('cancel', b, o),
    'fixed-create': (b, o) => customStep('create', b, o),
    'fixed-token': (b, o) => customStep('token', b, o),
    'fixed-on': (b, o) => onAndWait('custom', (o && o.by) || null),
    'fixed-off': () => offIf('custom'),
    'fixed-forget': (b, o) => customStep('forget', b, o),
    'fixed-add-service': (b, o) => customStep('add-service', b, o),
    'fixed-remove-service': (b, o) => customStep('remove-service', b, o),
    'quick-service-start': (b, o) => temporaryStep('add-service', b, o),
    'quick-service-stop': (b, o) => temporaryStep('remove-service', b, o),
  },
  attach: () => attach(),
  detach,
  closeOpenedBy,
  profile: null,
};
