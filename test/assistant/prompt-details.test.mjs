// Asked for a change in a project ("put the opening hours on my shop website"), Tia starts the work with his words as
// the task: details of the work he did not give (the days and times, which page) are the session's to ask him in its
// chat, never a reason for her to hold the start and ask first. Asking first stays for a choice of hers she cannot
// settle with a read tool (two projects fit).
import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_PROMPT } from '../../src/assistant/prompt.mjs';

test('details of the work he did not give are the session\'s to ask, so she starts with his words', () => {
  assert.match(BASE_PROMPT, /Details of the work itself that he did not give \([^)]*the days and times[^)]*\) are not such a choice: they are the session's to ask him, so start the work with his words as the task\./);
  assert.match(BASE_PROMPT, /start_chat with the task as the first message and a goal \(his words are the task; never hold the start to ask him for details the session can ask him in its chat\)/);
});

test('a project he names that is not in this computer\'s workspace: her words say so, and where it is, whatever she does next', () => {
  assert.match(BASE_PROMPT, /"Do <this> in <project>"[^\n]*when the project he names is not in this computer's workspace, your words to him say so, and where it is when it is on another computer, whatever you do next: ask him, or stage a start there that waits for his tap\)/);
});

test('asking first stays for a choice she cannot settle (two projects fit), with options', () => {
  assert.match(BASE_PROMPT, /Ask him only when his words leave a choice open that you cannot settle with a read tool/);
  assert.match(BASE_PROMPT, /When you must ask \(two projects fit, two ways are possible\), ask with notify_owner and its options/);
});
