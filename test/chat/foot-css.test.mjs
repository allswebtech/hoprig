// The foot's look, pinned in the stylesheets (the pictures are looked at in a real browser; this holds the rules that
// make it one rounded box, round buttons true circles and every press target a finger's size on a touch screen).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const chat = css('chat/chat.css');
const rule = (src, sel) => {
  const i = src.indexOf(`${sel} {`);
  assert.ok(i >= 0, `a rule for ${sel}`);
  return src.slice(i, src.indexOf('}', i));
};

test('no band around the dock: the box stands on the chat\'s own colour', () => {
  const dock = rule(chat, '.chat-dock');
  assert.match(dock, /background: transparent/);
  assert.match(dock, /border-top: 0/);
});

test('the input is one rounded box with a border, 22 px round on a phone; its field has none of its own', () => {
  assert.match(rule(chat, '.chat-composer'), /border: 1px solid var\(--border-strong\); border-radius: 16px; background: var\(--surface\)/);
  assert.match(chat, /@media \(max-width: 599px\) \{[\s\S]*\.chat-composer \{ border-radius: 22px; \}/);
  assert.match(rule(chat, '.chat-composer:focus-within'), /border-color: var\(--ring\)/, 'no accent ring');
  const field = rule(css('page-session.css'), '.chat-composer textarea.msg');
  assert.match(field, /border: 0/);
  assert.match(field, /background: transparent/);
});

test('every round button of the row is a true circle: width and height are the same variable, 32 px, 44 px on touch and on a phone', () => {
  const btn = rule(chat, '.chat-composer .chat-box-row .btn.icon');
  assert.match(btn, /width: var\(--hit\); height: var\(--hit\); min-height: var\(--hit\)/);
  assert.match(btn, /border-radius: 50%/);
  assert.match(rule(chat, '.chat-box-row'), /--hit: 32px/);
  assert.match(chat, /@media \(pointer: coarse\), \(max-width: 599px\) \{\s*\.chat-box-row \{ --hit: 44px; min-height: 44px; \}/);
  assert.match(chat, /\.chat-chips \.chat-chip, \.chat-ring \{ min-height: 44px; height: 44px; \}/);
  assert.match(chat, /\.chat-setpill \{ align-items: center;[^}]*height: 44px/);
});

test('Stop is a neutral circle, never red; Send is the accent circle and goes grey with nothing to send', () => {
  assert.match(rule(chat, '.chat-composer .chat-stop'), /background: var\(--text\); color: var\(--surface\)/);
  assert.match(rule(chat, '.chat-composer .chat-send.chat-send-empty'), /background: var\(--surface-3\)/);
  assert.doesNotMatch(fs.readFileSync(new URL('../../web/chat/composer.js', import.meta.url), 'utf8'), /chat-stop[^\n]*danger|danger[^\n]*chat-stop/);
});

test('the field is 16 px on a phone (a phone zooms the page on a smaller one), with a one-line placeholder', () => {
  assert.match(css('page-session.css'), /@media \(max-width: 599px\) \{ \.chat-composer textarea\.msg \{[^}]*font-size: 16px/);
  assert.match(chat, /textarea\.chat-input::placeholder \{ font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
});

test('the box never exceeds its column: every part of the row can shrink, and the pill is cut with an ellipsis', () => {
  assert.match(rule(chat, '.chat-composer'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule(chat, '.chat-box-row'), /min-width: 0/);
  assert.match(chat, /\.chat-setpill \{ align-items: center;[^}]*min-width: 0/);
});

test('the sheet This session has rows of 56 px', () => {
  assert.match(rule(chat, '.chat-set-row'), /min-height: 56px/);
});
