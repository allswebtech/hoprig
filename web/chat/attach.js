// The files to send with the next message: from the paperclip, pasted into the box or dropped on the page. Each is
// uploaded at once into the chat's uploads folder (the server's upload route) and shown as a chip, a picture with
// its thumbnail, until it is sent or removed. The server sends a picture as an image and names any other file for
// the coding tool to read (src/chat/files.mjs).
import { icon } from '../icons.js';
import { bytes, fill, h, toast, url } from '../lib.js';
import { ownMessageView } from './words.js';

const PICTURE = /^image\/(png|jpeg|gif|webp)$/;
const THUMB_MAX = 5 * 1024 * 1024; // larger pictures go as a file anyway (src/chat/files.mjs)
// The page's rules allow pictures from itself and data: addresses, not blob: ones: the thumbnail is read as data.
const readThumb = (file) => new Promise((resolve) => {
  const r = new FileReader();
  r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
  r.onerror = () => resolve(null);
  r.readAsDataURL(file);
});
/** The name a file was uploaded under, without the time and the tag the upload route put before it. */
export const shownName = (n) => String(n || '').replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, '');

/** o: { A (the chat's API path), changed() (the list or its uploads changed) } */
export function createAttachments(o) {
  let items = []; // { file, name, size, picture, thumb (object URL), path (when uploaded), pct, error }
  const el = h('ul.chat-attach', { 'aria-label': 'Files to send with the message' });

  const upload = (it) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // XHR, not fetch: it reports upload progress
    xhr.open('POST', url(`${o.A}/upload`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(it.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      it.pct = Math.round((e.loaded / e.total) * 100);
      paint();
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body.path) resolve(body.path);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
    xhr.send(it.file);
  });

  function remove(it) {
    items = items.filter((x) => x !== it);
    paint();
  }

  function paint() {
    fill(el, items.map((it) => {
      const state = it.error ? 'failed' : it.path ? bytes(it.size) : `uploading ${it.pct || 0}%`;
      return h(`li.chat-file${it.error ? '.chat-is-err' : ''}${it.picture ? '.chat-file-pic' : ''}`,
        it.thumb ? h('img.chat-file-thumb', { src: it.thumb, alt: '' }) : h('span.chat-file-icon', { 'aria-hidden': 'true' }, icon('paperclip', { size: 14 })),
        h('span.chat-file-main', h('span.chat-file-name', it.name), h('span.chat-file-sub', state)),
        h('button.chat-file-x', { type: 'button', 'aria-label': `Do not send ${it.name}`, title: 'Remove', onclick: () => remove(it) }, icon('x', { size: 14 })));
    }));
    o.changed();
  }

  return {
    el,
    /** Files chosen, pasted or dropped: each shown at once and uploaded. */
    async take(list) {
      const files = [...(list || [])].filter((f) => f && f.size >= 0);
      if (!files.length) return;
      const added = files.map((file) => {
        const picture = PICTURE.test(file.type || '');
        // A pasted picture is called "image.png" by every browser: give it a name that says when.
        const name = picture && /^image\.\w+$/.test(file.name || '') ? `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${file.type.split('/')[1].replace('jpeg', 'jpg')}` : file.name || 'file';
        return { file, name, size: file.size, picture, thumb: null, path: null, pct: 0, error: null };
      });
      items.push(...added);
      paint();
      for (const it of added) {
        if (it.picture && it.size <= THUMB_MAX) {
          readThumb(it.file).then((t) => {
            it.thumb = t;
            if (items.includes(it)) paint();
          });
        }
        it.pending = upload(it).then((p) => {
          it.path = p;
        }, (e) => {
          it.error = e.message;
          toast(`${it.name}: ${e.message}`, { kind: 'error' });
        }).finally(() => {
          it.pending = null;
          paint();
        });
      }
    },
    /** The uploaded files for the message ([{ path }]); waits for uploads still running. */
    async ready() {
      await Promise.all(items.map((x) => x.pending).filter(Boolean));
      return items.filter((x) => x.path).map((x) => ({ path: x.path }));
    },
    uploading: () => items.some((x) => x.pending),
    count: () => items.filter((x) => !x.error).length,
    clear() {
      items = [];
      paint();
    },
  };
}

/**
 * A queued message as its row above the box says it, the way its bubble will: its words, and its files by name (not
 * the "@.uploads/…" paths written for the coding tool). → { text, names, label (the words and the names, for the row's
 * Remove button) }
 */
export function queuedLine(m) {
  const { text, files } = ownMessageView(m.text, Array.isArray(m.attachments) ? m.attachments : []);
  const names = files.map((f) => shownName(f.name) || (f.type === 'image' ? 'picture' : 'file'));
  const words = text.trim();
  return { text: words, names, label: words && names.length ? `${words} (${names.join(', ')})` : words || names.join(', ') };
}

/** A message's files in the conversation: pictures as thumbnails (served from this chat's uploads), others as chips. */
export function messageFiles(files, A) {
  if (!files.length) return null;
  return h('div.chat-files', files.map((f) => {
    const name = shownName(f.name) || (f.type === 'image' ? 'picture' : 'file');
    const chip = () => h('span.chip.small', icon(f.type === 'image' ? 'sparkle' : 'paperclip', { size: 12 }), name);
    if (f.type !== 'image' || !f.name) return chip();
    const src = url(`${A}/attachment?name=${encodeURIComponent(f.name)}`);
    const img = h('img.chat-thumb', { src, alt: `Picture ${name}`, loading: 'lazy' });
    const a = h('a.chat-thumb-link', { href: src, target: '_blank', rel: 'noopener', title: name }, img);
    img.addEventListener('error', () => a.replaceWith(chip()), { once: true }); // not on this computer, or removed
    return a;
  }));
}
