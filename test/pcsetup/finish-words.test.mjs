// What a fresh clone would set up names a folder inside the project with `/` between its parts on every system
// (src/pcsetup/finish.mjs insideWords): on Windows path.relative gave a backslash, so a line read
// "copy .env.example to .env in shop/code\shop-api" and "link ... to ai_brain\claude-memory".
import assert from 'node:assert/strict';
import test from 'node:test';
import { insideWords } from '../../src/pcsetup/finish.mjs';

test('Windows: a folder inside the project is written with / between its parts', () => {
  const root = 'C:\\Users\\ann\\Workspace\\projects\\shop';
  assert.equal(insideWords(root, `${root}\\code\\shop-api`, 'win32'), 'code/shop-api');
  assert.equal(insideWords(root, `${root}\\ai_brain\\claude-memory`, 'win32'), 'ai_brain/claude-memory');
  assert.equal(insideWords(root, root, 'win32'), '');
  // Windows compares the letter case of a folder as it is: the same folder in another case is still inside
  assert.equal(insideWords(root, 'c:\\users\\ann\\Workspace\\projects\\shop\\code\\shop-web', 'win32'), 'code/shop-web');
});

test('Linux and macOS: path.relative as it is', () => {
  const root = '/home/ann/Workspace/projects/shop';
  for (const platform of ['linux', 'darwin']) {
    assert.equal(insideWords(root, `${root}/code/shop-api`, platform), 'code/shop-api');
    assert.equal(insideWords(root, `${root}/ai_brain/claude-memory`, platform), 'ai_brain/claude-memory');
  }
});
