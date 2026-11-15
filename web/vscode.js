// VS Code for a folder: in this browser (VS Code's own browser version, behind this dashboard's login), on this
// computer's own screen, or (Advanced) in the VS Code of the device in your hand over SSH. The server part is
// src/vscode/. Only for this computer for now: another computer's folders open from that computer's own dashboard.
import { api, btn, fill, h, link, machine, openSheet, tildePath, toast } from './lib.js';
import { icon } from './icons.js';
import { registerSessionAction, registerSettingsPage } from './registry.js';
import { errorBox, field, fold, info, panel, saveBar, skeletonRows, toggle } from './shell.js';
import { store } from './store.js';

/** VS Code in the browser for `dir` (VS Code opens the folder given as ?folder=). */
export const browserUrl = (dir) => `/vscode/?folder=${encodeURIComponent(dir)}`;

/** A vscode:// link that opens `dir` of this computer in the device's own VS Code over Remote-SSH. */
export function sshLink(target, dir) {
  const p = /^[A-Za-z]:[\\/]/.test(dir) ? `/${dir.replace(/\\/g, '/')}` : dir; // a Windows folder: /C:/Users/…
  return `vscode://vscode-remote/ssh-remote+${target}${p.split('/').map(encodeURIComponent).join('/')}`;
}

const external = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const licenseWords = (st) => [
  'It is Microsoft\'s VS Code Server: turning it on means you accept its ',
  external(st.license.url, 'license terms'), ' and ', external(st.license.privacy, 'privacy statement'), '.',
];

/** The sheet: the ways to open `dir`, the common one first. */
function sheetBody(st, dir, close) {
  const box = h('div.choice-list');
  const paint = () => {
    const rows = [];
    if (!st.installed) {
      rows.push(h('div.banner.warn', icon('alert', { size: 18 }), h('span', 'VS Code is not installed on this computer. ', st.install.text, ' ', external(st.install.url, 'Download VS Code'))));
    } else if (st.browser === false) {
      // Windows: not offered yet (src/vscode/process.mjs says why); the other ways below still are.
    } else if (st.enabled && st.license.accepted) {
      rows.push(h('a.choice', { href: browserUrl(dir), target: '_blank', rel: 'noopener', onclick: () => close() },
        h('span.choice-icon', icon('code')),
        h('span.choice-main', h('span.choice-label', 'In this browser'), h('span.choice-sub', 'VS Code in a new tab, through this page. The first start can take a minute.')),
        h('span.choice-end', icon('external'))));
    } else {
      const go = btn('primary', { label: st.license.accepted ? 'Turn it on' : 'Accept and turn on', onclick: async () => {
        go.disabled = true;
        try {
          Object.assign(st, await api('/api/vscode/settings', st.license.accepted ? { enabled: true } : { acceptLicense: true, enabled: true }));
          paint();
        } catch (e) {
          go.disabled = false;
          toast(e.message, { kind: 'error' });
        }
      } });
      rows.push(h('div.card.vs-setup',
        h('p.choice-label', 'In this browser'),
        h('p.hint', 'VS Code\'s browser version runs on this computer and opens in a tab here, wherever you reach this page. ', ...(st.license.accepted ? [] : licenseWords(st))),
        h('div.btnrow', go)));
    }
    if (st.installed && st.desktop.available) {
      rows.push(h('button.choice', { type: 'button', onclick: async () => {
        try {
          await api('/api/vscode/desktop', { dir });
          toast('VS Code is opening on this computer\'s screen.');
          close();
        } catch (e) {
          toast(e.message, { kind: 'error' });
        }
      } },
      h('span.choice-icon', icon('cpu')),
      h('span.choice-main', h('span.choice-label', 'On this computer\'s screen'), h('span.choice-sub', 'Opens the VS Code app on the computer itself, not on the device in your hand.')),
      h('span.choice-end', icon('chevronRight'))));
    }
    rows.push(fold('vscode-sheet', 'Advanced', st.sshTarget
      ? h('a.choice', { href: sshLink(st.sshTarget, dir), onclick: () => close() },
        h('span.choice-icon', icon('terminal')),
        h('span.choice-main', h('span.choice-label', 'In VS Code on this device'), h('span.choice-sub', `Over SSH as ${st.sshTarget}. Needs VS Code with Remote - SSH on this device.`)),
        h('span.choice-end', icon('external')))
      : h('p.hint', 'To open it in the VS Code of the device in your hand over SSH, set the SSH address in ', h('a', { href: link('#/settings/vscode'), onclick: () => close() }, 'Settings → VS Code'), '.')));
    fill(box, rows);
  };
  paint();
  return box;
}

/** Ask how to open `dir` in VS Code, then do it. */
export async function openInVscode(dir) {
  if (machine.current) return toast('VS Code opens folders of this computer only. Use that computer\'s own dashboard for its folders.');
  let st;
  try {
    st = await api('/api/vscode');
  } catch (e) {
    return toast(e.message, { kind: 'error' });
  }
  return openSheet({ title: 'Open in VS Code', subtitle: tildePath(dir) }, (close) => sheetBody(st, dir, close));
}

/** "VS Code" for a folder; nothing on another computer's screen. `compact`: the icon alone. */
export function vscodeButton(dir, { name = '', compact = false } = {}) {
  if (!dir || machine.current) return null;
  const title = name ? `Open ${name} in VS Code` : 'Open in VS Code';
  return compact
    ? btn('icon ghost small', { icon: 'code', title, onclick: () => openInVscode(dir) })
    : btn('small secondary', { icon: 'code', label: 'VS Code', title, onclick: () => openInVscode(dir) });
}

registerSessionAction({
  id: 'vscode',
  label: 'Open in VS Code',
  sub: 'This session\'s folder, in the browser or on this computer',
  icon: 'code',
  describe: (s) => (s.machine || !(store.data?.sessions || []).some((x) => x.name === s.name && x.cwd) ? null : {}),
  run: (s) => {
    const found = (store.data?.sessions || []).find((x) => x.name === s.name);
    if (found && found.cwd) openInVscode(found.cwd);
  },
});

// ---------- Settings → VS Code ----------

function settingsBody() {
  const box = h('div', skeletonRows(2));
  const paint = (st) => {
    const idle = { minutes: st.idleMinutes };
    const ssh = { target: st.sshTarget };
    const accept = btn('primary', { label: 'Accept and turn on', disabled: !st.installed, onclick: async () => {
      try {
        paint(await api('/api/vscode/settings', { acceptLicense: true, enabled: true }));
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    } });
    fill(box,
      st.installed ? null : panel({ icon: 'alert', title: 'VS Code is not installed', desc: st.install.text },
        h('div.btnrow', h('a.btn.secondary', { href: st.install.url, target: '_blank', rel: 'noopener noreferrer' }, icon('download', { size: 18 }), h('span', 'Download VS Code')))),
      st.browser === false ? panel({ icon: 'code', title: 'VS Code in the browser', desc: 'Not offered on Windows yet. Open in VS Code still offers this computer\'s screen and SSH.' }) : panel({ icon: 'code', title: 'VS Code in the browser', desc: 'VS Code\'s browser version runs on this computer and opens in a tab of this page, wherever you reach it: at home or through the public link.' },
        st.license.accepted
          ? [toggle('VS Code in the browser', st.enabled, async (v) => {
            try {
              Object.assign(st, await api('/api/vscode/settings', { enabled: v }));
            } catch (e) {
              toast(e.message, { kind: 'error' });
              throw e;
            }
          }, 'Starts when you open a folder in it and stops by itself when no VS Code tab is open. Off: it never starts.'),
          info('Now', st.running ? 'Running' : st.starting ? 'Starting' : 'Not running', st.error && !st.running ? `The last start failed: ${st.error}` : null),
          field('Stop after (minutes without a VS Code tab)', h('input.field', { type: 'number', min: 5, max: 1440, value: String(idle.minutes), oninput: (e) => (idle.minutes = Number(e.target.value)) }), 'It starts again when you open a folder.'),
          saveBar('Save', () => api('/api/vscode/settings', { idleMinutes: idle.minutes })),
          h('p.hint', `You accepted the VS Code Server license on ${new Date(st.license.at).toLocaleDateString()}.`)]
          : [h('p.hint', 'Off until you turn it on. ', ...licenseWords(st)), h('div.btnrow', accept)]),
      panel({ icon: 'cpu', title: 'On this computer\'s screen', desc: st.desktop.available
        ? 'Open in VS Code also offers the VS Code app on this computer\'s own screen.'
        : 'Not offered: the dashboard runs without a desktop session it can open a window in (for example as a background service on Linux).' }),
      fold('settings-vscode', 'Advanced',
        panel({ icon: 'terminal', title: 'VS Code on another device, over SSH', desc: 'For a device whose VS Code has the Remote - SSH extension and reaches this computer by SSH. Open in VS Code then offers "In VS Code on this device".' },
          field('SSH address of this computer', h('input.field.mono', { value: ssh.target, placeholder: 'you@this-computer', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (ssh.target = e.target.value.trim()) }), 'As that device reaches it: user@host, or a Host name from its SSH config. Empty: not offered.'),
          saveBar('Save', () => api('/api/vscode/settings', { sshTarget: ssh.target })))),
      h('p.hint', 'For the folders of this computer. Another computer\'s folders open in VS Code from that computer\'s own dashboard.'));
  };
  api('/api/vscode').then(paint, (e) => fill(box, errorBox(e.message)));
  return box;
}

registerSettingsPage({
  id: 'vscode', title: 'VS Code', icon: 'code', order: 55, onlyHere: true,
  desc: 'Open project folders in VS Code: in the browser through this page, or on this computer\'s screen.',
  summary: async () => {
    const st = await api('/api/vscode');
    if (!st.installed) return 'Not installed';
    return st.enabled ? (st.running ? 'On · running now' : 'On') : 'Off';
  },
  render: () => [settingsBody()],
});
