// Projects (the address stays #/workspace): three tabs first, one row per project (name, one line, one New session),
// one Add project door with a sheet of three ways, an end fold for Sync, Other folders, Groups and the folder; a
// project's page is short (sessions, one Repositories row, one Skills row, a Memory fold; Sync under Advanced).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const src = read('projects.js');
const { ADD_WAYS, projectLine } = await import('../../web/projects.js');

const listBody = src.slice(src.indexOf('function viewList('), src.indexOf('/** The places of GET /api/pcsetup/projects'));
const projectBody = src.slice(src.indexOf('function viewProject('), src.indexOf('function viewProjects('));

const repo = (o = {}) => ({ ok: true, branch: 'main', changes: 0, ahead: 0, behind: 0, upstream: true, rel: '.', ...o });

test('the page is named Projects, and its tabs are the first thing in its body, with no intro line', () => {
  assert.match(src, /registerPage\(\{ id: 'workspace', title: 'Projects'/);
  assert.match(listBody, /title: 'Projects'/);
  assert.ok(listBody.includes('body: [projectsTabs(\'projects\'), body, more]'), 'tabs, the rows, the fold at the end');
  assert.doesNotMatch(listBody, /intro:/, 'no intro line');
});

test('Add project is the one door: a sheet of three ways; no other button for them on the page', () => {
  assert.deepEqual(ADD_WAYS.map((w) => [w.title, w.href]), [['New project', '#/new-project'], ['Get from GitHub', '#/get-project'], ['Found on this computer', '#/adopt']]);
  assert.match(listBody, /primary: \{ label: 'Add project'.*onclick: addSheet/);
  assert.doesNotMatch(listBody, /actions: \[/, 'no second and third door in the head');
  assert.doesNotMatch(listBody, /Get an existing project|Projects found on this computer/);
});

test('a project row: name, one line (needs you first, then the git state), one New session; the rest is on its page', () => {
  const calm = projectLine({ repos: [repo()] }, []);
  assert.deepEqual(calm, { text: 'branch main · up to date', attn: false });
  assert.equal(projectLine({ repos: [repo({ changes: 2 })] }, []).attn, true, 'changes not saved: a look');
  const needs = projectLine({ repos: [repo()] }, [{ status: 'waiting', note: 'a question' }]);
  assert.ok(typeof needs.text === 'string' && needs.text.endsWith('branch main · up to date'));
  const row = src.slice(src.indexOf('function projectRow('), src.indexOf('/** A project of the workspace map that is not'));
  assert.match(row, /newSessionButton\(p\.dir, p\.name\)/);
  for (const gone of ['editorButton', 'chevronRight', 'earlier(', 'No session yet', 'sessionRow']) assert.ok(!row.includes(gone), `${gone} is not on a row`);
});

test('Sync, Other folders, Groups, the computers and the folder are one closed fold at the end', () => {
  assert.match(listBody, /fold\('projects-more', 'More', strip\.el, rest\)/);
  const rest = listBody.slice(listBody.indexOf('fill(rest,'));
  for (const part of ['otherFolders(', 'groupsLine(', 'computersPanel(', 'folderLine(']) assert.ok(rest.includes(part), `${part} is in the fold`);
  assert.doesNotMatch(listBody, /fold\('projects', 'Advanced'/, 'no second fold');
  assert.match(listBody, /needs a look/, 'the fold says so when the map needs a look');
});

test('a project page: no intro, Open code in the head, sessions, one Repositories row, one Skills row, a Memory fold', () => {
  assert.doesNotMatch(projectBody, /intro:/);
  assert.ok(projectBody.includes('body: [sessionsBox, pastBox, reposFold, needsBox, skillsBox, brainFold, fold(\'project\', \'Advanced\', advanced)]'));
  assert.match(projectBody, /actions: p \? \[editorButton\(p\.dir/);
  assert.match(projectBody, /backLabel: 'Projects'/);
  for (const head of ["groupHead('Repositories')", "groupHead('Skills')", "groupHead('AI brain')", 'pj-lead']) assert.ok(!projectBody.includes(head), `${head} is gone`);
  assert.match(projectBody, /foldRow\('Memory'/);
  assert.match(projectBody, /foldRow\('Repositories'/);
});

test('Sync and Add a repository are under Advanced, not beside the repositories', () => {
  const paintRepos = projectBody.slice(projectBody.indexOf('function paintRepos()'), projectBody.indexOf('/** Run a job from a button'));
  assert.ok(!paintRepos.includes("label: 'Sync'") && !paintRepos.includes('Add a repository'));
  const adv = projectBody.slice(projectBody.indexOf('function paintAdvanced()'), projectBody.indexOf('async function load('));
  assert.ok(adv.includes("label: 'Sync'") && adv.includes("label: 'Add a repository'") && adv.includes('resultBox'));
});

test('the skills part is one row with a count, not a list of skills', () => {
  const skills = projectBody.slice(projectBody.indexOf('async function loadSkills()'), projectBody.indexOf('// ---- advanced ----'));
  assert.match(skills, /title: 'Skills'/);
  assert.doesNotMatch(skills, /here\.map/);
});

test('the pages that lead back say Projects, and every old address is still a page', () => {
  for (const f of ['projects.js', 'adopt.js']) assert.doesNotMatch(read(f), /backLabel: 'Workspace'/, f);
  const app = read('app.js');
  for (const a of ["'#/workspace'", "'#/new-project'", "'#/get-project'"]) assert.ok(app.includes(a), a);
  assert.match(app, /\^\\\/projects\(\\\/\(\.\+\)\)\?\$\//, '#/projects… lands on the page');
  assert.match(src, /registerPage\(\{ id: 'new-project'.*navAs: 'workspace'/);
  assert.match(src, /registerPage\(\{ id: 'get-project'.*navAs: 'workspace'/);
  assert.match(read('adopt.js'), /registerPage\(\{ id: 'adopt'[^\n]*navAs: 'workspace'/);
});
