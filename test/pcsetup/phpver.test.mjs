// The PHP version a project asks for (composer.json require.php) against the PHP here: Composer's constraint shapes,
// read as Composer reads them (https://getcomposer.org/doc/articles/versions.md), and the note in plain words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PHP_SERIES, fitOf, parseConstraint, phpNote, rangeWords, versionNumbers } from '../../src/pcsetup/phpver.mjs';
import { kitById } from '../../src/pcsetup/kits.mjs';

const fits = (c, v) => {
  const p = parseConstraint(c);
  assert.ok(p.ok, `${c} could not be read: ${p.why}`);
  return fitOf(v, p);
};

test('every constraint shape Composer documents, at its edges', () => {
  const cases = [
    // caret: up to the next major; ^0.3 up to 0.4
    ['^8.1', '8.1.0', true], ['^8.1', '8.9.9', true], ['^8.1', '9.0.0', false], ['^8.1', '8.0.30', false], ['^0.3', '0.3.9', true], ['^0.3', '0.4.0', false],
    // tilde: ~8.1 up to 9.0, ~8.1.2 up to 8.2
    ['~8.1', '8.9', true], ['~8.1', '9.0', false], ['~8.1.2', '8.1.9', true], ['~8.1.2', '8.2.0', false], ['~8.1.2', '8.1.1', false],
    // comparisons
    ['>=8.1', '8.1.0', true], ['>=8.1', '8.0.99', false], ['>8.1', '8.1.0', false], ['>8.1', '8.1.1', true], ['<=8.3', '8.3.0', true], ['<=8.3', '8.3.1', false], ['<8.4', '8.3.99', true], ['<8.4', '8.4.0', false],
    ['!=8.2.0', '8.2.1', true], ['!=8.2.0', '8.2.0', false],
    // exact (8.2 is 8.2.0), wildcards
    ['8.2', '8.2.0', true], ['8.2', '8.2.1', false], ['8.2.*', '8.2.30', true], ['8.2.*', '8.3.0', false], ['8.*', '8.5', true], ['8.*', '9.0', false], ['*', '8.5', true],
    // AND with a space, with a comma, with a space after the operator
    ['^8.1 <8.4', '8.3.0', true], ['^8.1 <8.4', '8.5.0', false], ['>=8.1, <8.3', '8.2.9', true], ['>= 8.1 , < 8.3', '8.3.0', false],
    // OR with | and ||
    ['^7.4|^8.0', '8.5', true], ['^7.4 || ^8.0', '7.4.33', true], ['^7.4 || ^8.0', '7.3.0', false],
    // hyphen ranges: a partial upper end means "below the next one"
    ['8.1 - 8.3', '8.3.9', true], ['8.1 - 8.3', '8.4.0', false], ['8.1 - 8.3.0', '8.3.0', true], ['8.1 - 8.3.0', '8.3.1', false], ['8.1 - 8.3', '8.0.9', false],
    // a stability flag is left out; a v in front is allowed
    ['^8.1@stable', '8.2', true], ['>=v8.1', '8.1', true],
  ];
  for (const [c, v, want] of cases) assert.equal(fits(c, v).fits, want, `${c} with ${v}`);
});

test('a shape that cannot be read is said as such, never guessed', () => {
  for (const bad of ['dev-master', '@stable', 'garbage', '>=8.*', '^', '8.1 -', 'a - b', '', '   ', '||', '8.1.2.3.4', 'x'.repeat(201)]) assert.equal(parseConstraint(bad).ok, false, JSON.stringify(bad));
  for (const notText of [null, 8.1, ['^8.1'], { php: '^8' }, undefined]) assert.equal(parseConstraint(notText).ok, false, String(notText));
});

test('versions with extras are read as their numbers', () => {
  assert.deepEqual(versionNumbers('8.5.4-0ubuntu1.5'), [8, 5, 4, 0]);
  assert.deepEqual(versionNumbers('PHP 8.3.12 (cli) (built: …)'), [8, 3, 12, 0]);
  assert.equal(versionNumbers('none'), null);
  assert.equal(fits('^8.1 <8.4', '8.5.4-0ubuntu1.5').side, 'newer');
  assert.equal(fits('^8.3', '8.1.2').side, 'older');
  assert.equal(fits('!=8.2.0', '8.2.0').side, 'other');
  assert.equal(fits('>8.0 <8.2 || >=8.4 <8.5', '8.3.0').side, 'other', 'between two alternatives is neither newer nor older');
});

test('the note: fits, newer, older, no PHP, unreadable, two PHPs, another series', () => {
  const want = { project: 'shop', where: '', wants: '^8.1 <8.4' };
  const fit = phpNote({ ...want, wants: '^8.1' }, { version: '8.5.4', from: 'installed' });
  assert.equal(fit.verdict, 'fits');
  assert.equal(fit.text, 'shop needs PHP 8.1 or a later 8.x: PHP 8.5.4 here fits.');

  const newer = phpNote(want, { version: '8.5.4', from: 'installed' });
  assert.equal(newer.verdict, 'newer');
  assert.equal(newer.text, 'shop needs PHP 8.1 up to 8.3, and PHP 8.5.4 here is too new. What you can do: run shop in Docker with the official php:8.3 image (the Docker kit).');
  // What Hoprig never does is said once, in the kit's summary, not in every note.
  assert.doesNotMatch(newer.text, /never/);
  assert.match(kitById('php').summary, /Hoprig never removes or downgrades a PHP, adds a package source or changes which PHP the php command runs/);
  assert.equal(newer.offer, null);

  const older = phpNote({ ...want, wants: '>=8.4' }, { version: '8.2.1', from: 'installed' });
  assert.equal(older.verdict, 'older');
  assert.equal(older.text, 'shop needs PHP 8.4 or newer, and PHP 8.2.1 here is too old. What you can do: run shop in Docker with the official php:8.5 image (the Docker kit).');

  const none = phpNote(want, null);
  assert.equal(none.verdict, 'unknown');
  assert.match(none.text, /no PHP here yet, and which version the package manager installs is not known before it is installed/);

  const offered = phpNote(want, { version: '8.5', from: 'offered' });
  assert.equal(offered.verdict, 'newer');
  assert.equal(offered.text, 'shop needs PHP 8.1 up to 8.3. No PHP here yet; the PHP kit would install PHP 8.5, which is too new. What you can do: run shop in Docker with the official php:8.3 image (the Docker kit).');

  // Homebrew names a series only (php@8.3): it is compared as a series, never as 8.3.0.
  const brew = [{ series: '8.3', version: '8.3', argv: ['brew', 'install', 'php@8.3'], run: 'x' }];
  assert.equal(phpNote({ ...want, wants: '~8.3.2' }, { version: '8.5.4', from: 'installed' }, { series: brew }).offer, null, '8.3.0 and 8.3.1 do not fit ~8.3.2');
  assert.equal(phpNote(want, { version: '8.5.4', from: 'installed' }, { series: brew }).offer.series, '8.3');

  // apt: a newer series takes over the php command (its alternatives priority is its number), so only an older one is
  // offered beside; a newer one is named as not offered, and the container stays.
  const apt = (v) => ({ series: v, version: `${v}.4`, argv: ['sudo', 'apt-get', 'install', '-y', `php${v}-cli`], run: `php${v}`, takesOverIfNewer: true });
  const up = phpNote({ ...want, wants: '^8.5' }, { version: '8.3.6', from: 'installed' }, { series: [apt('8.5')] });
  assert.equal(up.verdict, 'older');
  assert.equal(up.offer, null);
  assert.match(up.text, /PHP 8\.5 of the package manager is not offered: installed beside PHP 8\.3\.6, it would become what the php command runs for every project/);
  assert.equal(phpNote(want, { version: '8.5.4', from: 'installed' }, { series: [apt('8.3')] }).offer.series, '8.3', 'an older series stays beside');

  const unread = phpNote({ ...want, wants: 'dev-master' }, { version: '8.5.4', from: 'installed' });
  assert.equal(unread.verdict, 'unreadable');
  assert.match(unread.text, /in a form Hoprig cannot read .*not compared: check it yourself/);
  assert.equal(phpNote({ ...want, wants: 8.1 }, { version: '8.5.4', from: 'installed' }).verdict, 'unreadable');

  // Two PHPs: `php` counts; another one on PATH that fits is named, with how to use it.
  const two = phpNote(want, { version: '8.5.4', from: 'installed' }, { others: [{ name: 'php8.3', version: '8.3.6' }] });
  assert.equal(two.verdict, 'newer');
  assert.equal(two.use, 'php8.3');
  assert.match(two.text, /What you can do: run shop's commands with php8\.3 \(PHP 8\.3\.6, here already\) instead of php; for Composer: php8\.3 "\$\(command -v composer\)" install; or run shop in Docker/);

  // Another series of the same package manager: offered first, beside the other PHP; the container second.
  const series = [{ series: '8.3', version: '8.3.6', argv: ['sudo', 'apt-get', 'install', '-y', 'php8.3-cli'], run: 'php8.3' }, { series: '8.4', version: '8.4.1', argv: ['x'], run: 'php8.4' }];
  const s = phpNote(want, { version: '8.5.4', from: 'installed' }, { series });
  assert.equal(s.offer.series, '8.3', 'the newest series that fits (8.4 does not)');
  assert.match(s.text, /What you can do: install PHP 8\.3 beside it \(the command below, only after your yes\) and run shop's commands with php8\.3; or run shop in Docker with the official php:8\.3 image/);
  assert.equal(phpNote({ ...want, where: 'code/shop-api' }, { version: '8.5.4', from: 'installed' }).text.slice(0, 26), 'shop (code/shop-api) needs');
});

test('the range in words for someone who does not read Composer\'s syntax; Composer\'s text only where there is no short wording', () => {
  const said = (c) => rangeWords(parseConstraint(c));
  assert.deepEqual(['^8.1 <8.4', '^8.1', '~8.1.2', '>=8.2', '<8.4', '<=8.3', '8.2.*', '8.1 - 8.3', '>=8.1, <8.3', '*'].map(said),
    ['PHP 8.1 up to 8.3', 'PHP 8.1 or a later 8.x', 'PHP 8.1.2 or a later 8.1.x', 'PHP 8.2 or newer', 'PHP 8.3 or older', 'PHP 8.3.0 or older', 'PHP 8.2.x', 'PHP 8.1 up to 8.3', 'PHP 8.1 up to 8.2', 'any PHP']);
  // "<=8.3" is <=8.3.0 in Composer: the words say so, and the image named is the newest series that fits as a whole.
  const upTo = phpNote({ project: 'shop', where: '', wants: '>=8.1 <=8.3' }, { version: '8.3.6', from: 'installed' });
  assert.equal(upTo.verdict, 'newer');
  assert.equal(upTo.text, 'shop needs PHP 8.1 up to 8.3.0, and PHP 8.3.6 here is too new. What you can do: run shop in Docker with the official php:8.2 image (the Docker kit).');
  assert.match(phpNote({ project: 'shop', where: '', wants: '<=8.3' }, { version: '8.3.6', from: 'installed' }).text, /^shop needs PHP 8\.3\.0 or older, and PHP 8\.3\.6 here is too new\. What you can do: run shop in Docker with the official php:8\.2 image/);
  assert.equal(said('<=8.3.5'), 'PHP 8.3.5 or older');
  for (const c of ['^7.4|^8.0', '8.2', '!=8.2.0']) assert.equal(said(c), null, c);
  const or = phpNote({ project: 'shop', where: '', wants: '^7.4|^8.0' }, { version: '7.3.1', from: 'installed' });
  assert.match(or.text, /^shop asks for PHP \^7\.4\|\^8\.0 in its composer\.json, and PHP 7\.3\.1 here is too old\. What you can do: run shop in Docker with the official php image of a version that fits/);
  // The note fits about three lines at 390 px (about 55 characters a line on the Setup tab).
  const n = phpNote({ project: 'shop', where: '', wants: '^8.1 <8.4' }, { version: '8.5', from: 'offered' });
  assert.ok(n.text.length <= 200, `${n.text.length} characters: ${n.text}`);
});

/** The Docker image a note names, or null when it names none ("the official php image of a version that fits"). */
const imageOf = (text) => (/official php:(\d+\.\d+) image/.exec(text) || [])[1] || null;
const timed = (f) => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};

test('the container is picked from a short fixed list of real PHP series: no number in a composer.json is ever walked', () => {
  assert.ok(PHP_SERIES.length <= 20, 'a short list');
  assert.deepEqual([...PHP_SERIES].sort((a, b) => -compareSeries(a, b)), PHP_SERIES, 'newest first');
  const installed = { version: '7.0.1', from: 'installed' };
  const cases = [
    // [constraint, the image it must name (null: none named), what its words must say, the PHP here (else 7.0.1)]
    ['>=7.4 <=7.99', '7.4', /needs PHP 7\.4 up to 7\.99\.0, and PHP 7\.0\.1 here is too old/],
    ['<=8.300000', '8.5', /needs PHP 8\.300000\.0 or older, and PHP 8\.300001\.0 here is too new/, '8.300001.0'],
    ['>=8.1 <=8.999999999', '8.5', /needs PHP 8\.1 up to 8\.999999999\.0, and PHP 7\.0\.1 here is too old/],
    ['>=8.1 <=8.99', '8.5', /too old/],
    ['^8.1 <8.4', '8.3', /needs PHP 8\.1 up to 8\.3, and PHP 7\.0\.1 here is too old/],
    ['>=9.0', null, /needs PHP 9\.0 or newer, and PHP 7\.0\.1 here is too old\. What you can do: run shop in Docker with the official php image of a version that fits/],
    // twenty digits: more than a version part Hoprig reads (nine), so it says it cannot read it, and compares nothing
    ['>=8.1 <=8.99999999999999999999', null, /in a form Hoprig cannot read .*check it yourself/],
    // two hundred alternatives: longer than any real constraint, said as such
    [Array.from({ length: 200 }, (_, i) => `^8.${i}`).join(' || '), null, /in a form Hoprig cannot read \(it is too long\)/],
  ];
  for (const [wants, image, words, version] of cases) {
    const [n, ms] = timed(() => phpNote({ project: 'shop', where: '', wants }, version ? { version, from: 'installed' } : installed));
    assert.ok(ms < 50, `${wants.slice(0, 40)}: ${ms.toFixed(1)} ms`);
    assert.match(n.text, words, wants.slice(0, 40));
    assert.equal(imageOf(n.text), image, wants.slice(0, 40));
    if (image) {
      assert.ok(PHP_SERIES.includes(image), `${image} has an image`);
      assert.ok(fitOf(`${image}.999999`, parseConstraint(wants)).fits, `${image}'s newest release fits ${wants}`);
    }
  }
});

test('a few thousand random constraints: each answered in under 50 ms, none throws, any image named is a real one', () => {
  // A fixed seed, so a failure can be run again exactly (mulberry32: its low bits are as random as its high ones).
  let seed = 20261118;
  const rnd = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const bits = ['0', '1', '7', '8', '9', '.', '.', '>=', '<=', '<', '>', '!=', '=', '^', '~', ' ', ' ', ',', '||', '|', ' - ', '-', '*', 'x', '@stable', 'v'];
  const longNumber = () => String(rnd(10) + 1).repeat(1 + rnd(25));
  // A third are shaped as Composer writes them (an operator and a version whose parts have 1 to 9 digits, joined as AND,
  // OR or a range), so most can be read and reach the note with large numbers; a third are near a real series; a third are
  // any mix of the pieces.
  const num = () => String(rnd(10 ** (1 + rnd(9))));
  const version = () => Array.from({ length: 1 + rnd(3) }, num).join('.');
  const ops = ['', '>=', '<=', '<', '>', '!=', '^', '~', '=='];
  const shaped = () => {
    const alts = Array.from({ length: 1 + rnd(3) }, () => Array.from({ length: 1 + rnd(3) }, () => (rnd(6) === 0 ? `${version()} - ${version()}` : (rnd(10) === 0 ? `${version()}.*` : `${ops[rnd(ops.length)]}${version()}`))).join(rnd(2) ? ' ' : ', '));
    return alts.join(rnd(2) ? ' || ' : '|');
  };
  // A real PHP series at one end and a huge number at the other: the shape that froze the old walk of minors.
  const near = () => { const M = ['5', '7', '8'][rnd(3)]; const lo = `${M}.${rnd(6)}`; const hi = `${M}.${num()}${rnd(2) ? `.${num()}` : ''}`; return [`>=${lo} <=${hi}`, `^${lo} <${hi}`, `${lo} - ${hi}`, `<=${hi}`, `<${hi} || >=${lo}`][rnd(5)]; };
  let worst = 0;
  let readable = 0;
  let images = 0;
  for (let i = 0; i < 4000; i++) {
    let c = '';
    if (i % 3 === 1) c = shaped();
    else if (i % 3 === 2) c = near();
    else for (let k = 0, parts = 1 + rnd(30); k < parts; k++) c += rnd(6) === 0 ? longNumber() : bits[rnd(bits.length)];
    let n;
    const [, ms] = timed(() => {
      if (parseConstraint(c).ok) readable++;
      n = phpNote({ project: 'shop', where: '', wants: c }, { version: ['5.6.40', '8.5.4', '7.4.33'][i % 3], from: 'installed' });
    });
    worst = Math.max(worst, ms);
    assert.ok(ms < 50, `${JSON.stringify(c)}: ${ms.toFixed(1)} ms`);
    assert.equal(typeof n.text, 'string', JSON.stringify(c));
    const image = imageOf(n.text);
    if (image) {
      images++;
      assert.ok(PHP_SERIES.includes(image), `${JSON.stringify(c)} named php:${image}`);
    }
  }
  assert.ok(worst < 50, `slowest ${worst.toFixed(1)} ms`);
  // The sweep must reach the reading and the image, or it proves nothing (2690 readable, 611 images with this seed).
  assert.ok(readable >= 2000 && images >= 300, `${readable} readable, ${images} named an image`);
});

function compareSeries(a, b) {
  const [x, y] = [a, b].map((s) => s.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1];
}
