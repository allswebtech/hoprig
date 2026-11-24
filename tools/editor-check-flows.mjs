// Dev-only: the step-by-step part of tools/editor-check.mjs (the rows the fixes of research/editor-parity.md made),
// then the screenshots: 1440 px light first, then 390 px with touch, light and dark, and 1440 px dark.
import fs from 'node:fs';
import path from 'node:path';

const P = 'flows';
const ed = `monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent)`;

export async function flows(c) {
  const { ALPHA, sleep, check, chrome, ev, J, waitFor, openEditor, focusEditor, send, shot, resetApp, rectOf, center, click } = c;
  const disk = (p) => fs.readFileSync(path.join(ALPHA, p), 'utf8');
  resetApp();
  check(P, 'the editor opens app.js (1440 px, light)', await openEditor());
  await focusEditor(1, 1);

  // The status bar: line and column, the selection, spaces, encoding, line ends, language.
  await ev(`(${ed}.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 }), true)`);
  await sleep(300);
  const st = await ev(`document.querySelector('.ed-status').textContent`);
  check(P, 'the status bar names line, column, the selection, spaces, UTF-8, LF and the language', /Ln 1, Col 7 \(6 selected\)/.test(st) && /Spaces: 2/.test(st) && /UTF-8/.test(st) && /LF/.test(st) && /JavaScript/.test(st), st);

  // Ctrl+B: the side bar goes and comes back.
  await send('Ctrl+B');
  const noSide = await ev(`document.querySelector('.ed-wrap').classList.contains('ed-noside')`);
  await send('Ctrl+B');
  check(P, 'Ctrl+B hides and shows the side bar', noSide && !(await ev(`document.querySelector('.ed-wrap').classList.contains('ed-noside')`)));

  // A second tab, its menu, Close Others, reopen.
  await ev(`(location.hash = ${J(c.hashOf({ file: 'README.md' }))}, true)`);
  await waitFor(`document.querySelectorAll('.ed-tab').length === 2`);
  const r = await rectOf('.ed-tab:not(.on)');
  await c.chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + 20, y: r.y + 10, button: 'right', buttons: 2, clickCount: 1 });
  await c.chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 20, y: r.y + 10, button: 'right', buttons: 0, clickCount: 1 });
  const menu = await waitFor(`!!document.querySelector('.desk-menu')`, 3000) && await ev(`[...document.querySelectorAll('.desk-menu .desk-menu-item')].map((b) => b.textContent).join('|')`);
  check(P, 'a right click on a tab opens its menu, as VS Code\'s', !!menu && /Close Others/.test(menu) && /Close to the Right/.test(menu) && /Close Saved/.test(menu) && /Copy Relative Path/.test(menu) && /Reveal in Explorer View/.test(menu) && /Pin/.test(menu), menu);
  await shot('1440-light-tab-menu');
  await ev(`([...document.querySelectorAll('.desk-menu .desk-menu-item')].find((b) => b.textContent.startsWith('Close Others')).click(), true)`);
  await sleep(400);
  check(P, 'Close Others leaves one tab', (await ev(`document.querySelectorAll('.ed-tab').length`)) === 1);
  await focusEditor(1, 1);
  await send('Ctrl+K Shift+T');
  check(P, 'Ctrl+K Shift+T reopens the closed tab', await waitFor(`document.querySelectorAll('.ed-tab').length === 2`, 5000), await ev(`[...document.querySelectorAll('.ed-tab')].map((t) => t.textContent).join(',')`));
  await focusEditor(1, 1);
  const before = await ev(`document.querySelector('.ed-tab.on').textContent`);
  await send('Ctrl+K PageDown');
  check(P, 'Ctrl+K PageDown goes to the next tab', (await ev(`document.querySelector('.ed-tab.on').textContent`)) !== before);

  // The command palette lists the page's commands with their keys and the one line where a browser keeps a key.
  await focusEditor(1, 1);
  await send('Ctrl+Shift+P');
  await chrome.send('Input.insertText', { text: 'Close Editor' });
  await sleep(600);
  const pal = await ev(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((x) => x.textContent).join(' | ')`);
  check(P, 'the palette has View: Close Editor with its key and the line about Ctrl+W', /Close Editor \(a browser tab keeps Ctrl\+W\)/.test(pal), pal.slice(0, 300));
  await shot('1440-light-palette');
  await send('Escape');

  // Ctrl+K Ctrl+S: the list of the page's keys under the one plain line.
  await focusEditor(1, 1);
  await send('Ctrl+K Ctrl+S');
  const sh = await waitFor(`!!document.querySelector('dialog[open] .ed-keys')`, 3000);
  check(P, 'Ctrl+K Ctrl+S shows the keyboard shortcuts with the line about the browser', sh && /A browser tab keeps Ctrl\+W/.test(await ev(`document.querySelector('dialog[open]').textContent`)));
  await shot('1440-light-shortcuts');
  await send('Escape');
  await sleep(400);

  // The terminal: Ctrl+` opens the panel with the dashboard's own terminal in the opened folder.
  await focusEditor(1, 1);
  await send('Ctrl+`');
  const term = await waitFor(`(() => { const f = document.querySelector('.ed-panelarea:not(.hidden) iframe.ed-termframe'); return !!(f && f.contentDocument && f.contentDocument.querySelector('.xterm')); })()`, 20000);
  check(P, 'Ctrl+` opens a terminal in the panel', term, await ev(`(document.querySelector('.ed-panelarea') || {}).textContent || 'no panel'`));
  if (term) {
    await sleep(1500);
    await chrome.send('Input.insertText', { text: 'pwd' });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const pwd = await waitFor(`document.querySelector('iframe.ed-termframe').contentDocument.querySelector('.xterm-rows').textContent.includes('alpha')`, 8000);
    check(P, 'the terminal starts in the opened folder', pwd, await ev(`document.querySelector('iframe.ed-termframe').contentDocument.querySelector('.xterm-rows').textContent.slice(0, 200)`));
    await shot('1440-light-terminal');
    await send('Ctrl+`');
    check(P, 'Ctrl+` inside the terminal hides the panel again', await waitFor(`document.querySelector('.ed-panelarea').classList.contains('hidden')`, 3000));
  }

  // Replace across files: Ctrl+Shift+H, a preview, one press, an open file changes in its tab (undo takes it back).
  await focusEditor(1, 1);
  await ev(`(location.hash = ${J(c.hashOf({ file: 'src/app.js' }))}, true)`);
  await sleep(800);
  await focusEditor(1, 1);
  await send('Ctrl+Shift+H');
  check(P, 'Ctrl+Shift+H opens Search with Replace', await ev(`!document.querySelector('.ed-search-replace').classList.contains('hidden') && document.querySelector('.ed-act.on').ariaLabel === 'Search'`));
  await ev(`(() => { const i = document.querySelector('.ed-search-q'); i.focus(); i.value = 'price'; i.dispatchEvent(new Event('input')); const r = document.querySelector('.ed-search-r'); r.value = 'cost'; r.dispatchEvent(new Event('input')); return true; })()`);
  await waitFor(`document.querySelectorAll('.ed-hit').length > 3`, 8000);
  await sleep(400);
  check(P, 'the results show the replacement beside what goes', await ev(`!!document.querySelector('.ed-hit-del') && document.querySelector('.ed-hit-ins').textContent === 'cost'`));
  await shot('1440-light-replace-preview');
  await ev(`(document.querySelector('.ed-search-replace button').click(), true)`);
  await waitFor(`!!document.querySelector('dialog[open]')`, 3000);
  await ev(`([...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Replace').click(), true)`);
  await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /replaced in/.test(t.textContent))`, 15000);
  const said = await ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  // Search reads no file over 1 MB (src/editor/search.mjs LIMITS.fileBytes): the 2.3 MB log is not among the results.
  check(P, 'neither the binary file nor the big log (not searched) is written', fs.readFileSync(path.join(ALPHA, 'logo.png')).length === 79 && disk('big.log').startsWith('a line of a big log with a price'), said);
  check(P, 'notes.txt and src/style.css are changed on disk', disk('notes.txt') === 'cost list\n' && disk('src/style.css').includes('.cost'), said);
  check(P, 'the open app.js changed in its tab, not on disk, and is marked unsaved', disk('src/app.js').includes('i.price') && await ev(`${ed}.getModel().getValue().includes('i.cost')`) && await ev(`!!document.querySelector('.ed-tab.on.dirty')`));
  await focusEditor(1, 1);
  await send('Ctrl+Z');
  check(P, 'Ctrl+Z in the open file takes the replace back', await ev(`${ed}.getModel().getValue().includes('i.price')`));

  // The Explorer: Ctrl+X on a file, Ctrl+V on a folder moves it (as dragging it there does).
  await send('Ctrl+Shift+E');
  await ev(`(() => { const r = [...document.querySelectorAll('.ed-tree [role=treeitem]')].find((x) => x.dataset.path === 'notes.txt'); r.focus(); return true; })()`);
  await send('Ctrl+X');
  await ev(`(() => { const r = [...document.querySelectorAll('.ed-tree [role=treeitem]')].find((x) => x.dataset.path === 'src'); r.focus(); return true; })()`);
  await send('Ctrl+V');
  await sleep(800);
  check(P, 'Ctrl+X then Ctrl+V on a folder moves the file there', fs.existsSync(path.join(ALPHA, 'src', 'notes.txt')) && !fs.existsSync(path.join(ALPHA, 'notes.txt')));
  // Ctrl+K R: the open file is shown and chosen in the Explorer.
  await focusEditor(1, 1);
  await send('Ctrl+K R');
  check(P, 'Ctrl+K R reveals the open file in the Explorer', await ev(`document.activeElement && document.activeElement.dataset && document.activeElement.dataset.path === 'src/app.js'`));
  // A language Monaco cannot format: the one plain line.
  await ev(`(location.hash = ${J(c.hashOf({ file: 'tool.py' }))}, true)`);
  await sleep(1200);
  await focusEditor(1, 1);
  await send('Ctrl+Shift+I');
  check(P, 'format in a language without a formatter says so', await ev(`[...document.querySelectorAll('.toast')].some((t) => /No formatter for this language in the browser editor/.test(t.textContent))`));
  void click; void center;
}

export async function shots(c) {
  const { sleep, chrome, ev, J, open, waitFor, shot, resetApp, hashOf } = c;
  resetApp();
  const one = async (name, w, h, theme, mobile, q, after) => {
    await chrome.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await open(hashOf(q), { w, h, theme, mobile, wait: 1500, prefs: { 'page.theme': theme } });
    await waitFor(`!!document.querySelector('.ed-tree [role=treeitem]')`, 10000);
    await sleep(1500);
    if (after) await after();
    await shot(name);
  };
  await one('1440-light', 1440, 900, 'light', false, { file: 'src/app.js' });
  await one('1440-light-search', 1440, 900, 'light', false, { file: 'src/app.js', view: 'search' }, async () => {
    await ev(`(() => { document.querySelector('.ed-replace-toggle').click(); const i = document.querySelector('.ed-search-q'); i.value = 'total'; i.dispatchEvent(new Event('input')); const r = document.querySelector('.ed-search-r'); r.value = 'sum'; r.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1200);
  });
  await one('1440-dark', 1440, 900, 'dark', false, { file: 'src/app.js', view: 'changes' });
  await one('390-light-tree', 390, 844, 'light', true, {});
  await one('390-light-editor', 390, 844, 'light', true, { file: 'src/app.js' });
  await one('390-dark-search', 390, 844, 'dark', true, { view: 'search' }, async () => {
    await ev(`(() => { document.querySelector('.ed-replace-toggle').click(); const i = document.querySelector('.ed-search-q'); i.value = 'total'; i.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1200);
  });
  await one('390-dark-editor', 390, 844, 'dark', true, { file: 'src/app.js' }, async () => {
    // A long press on the tab: its menu, as a right click opens it.
    const r = await c.rectOf('.ed-tab');
    if (r) {
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + 20, y: r.y + 12 }] });
      await sleep(700);
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(300);
    }
  });
  c.check('shots', 'a long press on a tab opens its menu (390 px, touch)', await ev(`!!document.querySelector('.desk-menu')`));
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  void J;
}
