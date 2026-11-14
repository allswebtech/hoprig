// Login page: one password field. On success the server sets the session cookie and we go to the dashboard.
// URLs are relative, so the page also works under a base path.
import { APP_NAME } from './brand.js';

document.title = `${APP_NAME} – log in`;
document.getElementById('name').textContent = APP_NAME;
{
  const mark = document.createElement('img');
  Object.assign(mark, { src: 'icon.svg', alt: '', className: 'brandmark', width: 52, height: 52 });
  document.getElementById('mark').replaceWith(mark);
}
const form = document.getElementById('form');
const input = document.getElementById('password');
const error = document.getElementById('error');

if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  document.getElementById('insecure').classList.remove('hidden');
}

// A one-time sign-in link ("…/login#link=<token>", from a QR code): the token is in the #fragment, which browsers
// never send to a server, so it stays out of logs and a link preview cannot use it up. Sent once, then forgotten.
const link = /^#link=([A-Za-z0-9_-]{43})$/.exec(location.hash);
if (link) {
  history.replaceState(null, '', location.pathname + location.search);
  error.textContent = '';
  const note = document.getElementById('error');
  note.textContent = 'Signing in…';
  fetch('api/login/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link[1] }) })
    .then(async (r) => {
      if (r.ok) return location.replace('./');
      const body = await r.json().catch(() => ({}));
      note.textContent = body.error || `Signing in failed (${r.status}). Use the password instead.`;
    })
    .catch(() => {
      note.textContent = 'Cannot reach the computer. Check the connection.';
    });
} else {
  fetch('api/me')
    .then((r) => r.json())
    .then((me) => {
      if (me.authed) location.replace('./');
    })
    .catch(() => {});
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const r = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (r.ok) {
      location.replace('./');
      return;
    }
    const body = await r.json().catch(() => ({}));
    error.textContent = body.error || `Login failed (${r.status})`;
    input.select();
  } catch {
    error.textContent = 'Cannot reach the computer. Check the connection.';
  } finally {
    button.disabled = false;
  }
});
