// The moving story's stage, as plain numbers (no three.js, so the tests and the browser checks read the same thing the
// scene draws): a step's three screens stand on a slow ring under the step's words. The screen in front faces the
// visitor at full size, sharp; the other two stand on the ring at its sides, turned, darker and soft, cut by the
// window's edges. A change between two screens turns the ring by one screen: the leaving one turns away and blurs,
// the coming one turns in blurred and turns sharp only when it faces the visitor.
//
// Units: CSS pixels of the floor (the part of the window under the words), x to the right and y down from the floor's
// top left; the camera stands so that one unit at depth 0 is one CSS pixel, so the front screen lands on whole pixels.
export const DEG = Math.PI / 180;
export const FOV = 30;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
/** The camera's distance from the floor's plane: one unit at depth 0 is one CSS pixel of a floor `H` high. */
export const camDist = (H) => H / 2 / Math.tan((FOV / 2) * DEG);

const WIDE = 800 / 1280; // a desktop screen of the demo, height over width
export const PHONE_SHOT = 1688 / 780; // the demo at phone width (390×844 at 2×)

/**
 * Where the screens stand on a floor `W` × `H` (CSS px). `phones`: the step's screens are the demo on a phone.
 * - wide: a floor wider than high shows the desktop screens; the front one as tall as the floor allows.
 * - tall: a floor higher than wide (a phone, a tablet held upright) shows every screen at phone width, from its top.
 * - phones: a wide floor with the phone's screens: a row of phones, each at a phone's shape and about a phone's own
 *   size, the step's three screens repeated past both sides so the row reaches the window's edges.
 */
export function layout({ W, H, phones = false }) {
  const small = W < 700;
  const top = 8;
  const bottom = 16; // room for the front screen's shadow, within about 32 px of the window's bottom
  const room = Math.max(40, H - top - bottom);
  // A desktop screen as wide as the window lets it be, with a strip of the side screens beside it. Seen 21 Nov 2026 in
  // Chrome: at 700x900 the floor under the words is 700 by 676, a little wider than high, and a desktop screen there was
  // 508 by 318 at the floor's bottom with 340 px of empty window over it; at 1024x768 a side of 11 % (112 px) left it
  // 47 px under the words. A floor that a desktop screen fills less than 90 % of the height of (a tablet held upright)
  // shows the dashboard at phone width, as a floor higher than wide does: an empty strip over the whole row of screens
  // of more than a tenth of the floor was more than the 10 % a pinned stage may leave empty.
  const wideW = Math.round(Math.min(room / WIDE, W - 2 * Math.max(64, W * 0.08)));
  const form = phones ? (H > W ? 'tall' : 'phones') : H > W || wideW * WIDE < 0.9 * room ? 'tall' : 'wide';
  let w;
  let h;
  let ring;
  if (form === 'wide') {
    w = wideW;
    h = Math.round(w * WIDE);
    // The side screens reach the window's edges. Past 1440 px they stand a little nearer: at 1920x1080 the words' band
    // leaves 400 px of empty window at each of its ends, and with the side screens at the front's depth step 3's stage
    // was 10.6 % empty (measured in Chrome 22 Nov 2026).
    ring = { step: 28, side: 0.55 * W, back: -Math.max(0, W - 1440) / 12 };
  } else if (form === 'tall') {
    w = Math.round(small ? W - 64 : Math.min(W - 280, 620));
    h = Math.round(Math.min(room, w * PHONE_SHOT));
    ring = { step: 30, side: W / 2, back: 40 };
  } else {
    // A phone, from its top, as tall as the floor allows: 0.58 wide for 1 high and at most 470 px wide (404 px at
    // 1440x900, a phone's own size). Seen 20 Nov 2026 as boxes 1.1 wide for 1 high: the phone picture drawn 1.9x up
    // in a landscape card, which no longer read as a phone. Three phones alone left 18 to 37 % of the window empty,
    // so the row repeats past both sides (`strip`): a flat row, each one turned a little and 8 px from the next.
    h = Math.round(room);
    w = Math.round(Math.min(470, h * 0.58));
    ring = { step: 3, side: w + 8, back: 0 };
  }
  // The front screen stands on the floor's lower edge (with room for its shadow), in the middle.
  const cx = W / 2;
  const cy = H - bottom - h / 2;
  return { W, H, form, w, h, cx, cy, step: ring.step * DEG, R: ring.side / Math.sin(ring.step * DEG), back: ring.back, crop: form === 'wide' ? 1 : Math.min(1, h / w / PHONE_SHOT), strip: form === 'phones', turn: form === 'phones' ? 0.4 : 1 };
}

/** The copies of each screen a layout draws: a row of phones repeats the three screens on both sides. */
export const copies = (L) => (L.strip ? [-1, 0, 1] : [0]);

/** A screen's distance from the front on a ring of `n` (it wraps: the one that goes round the back fades). */
export const wrap = (d, n = 3) => ((((d + n / 2) % n) + n) % n) - n / 2;

/** A screen at distance `d0` from the front (0 front, -1 just passed, 1 next): where it stands and how it looks. */
export function pose(d0, L, n = 3) {
  // A row of phones does not wrap: each copy stands at its own place in the row and fades past 2.6 screens out.
  const d = L.strip ? d0 : wrap(d0, n);
  const a = Math.abs(d);
  const th = d * L.step;
  return {
    d,
    x: L.R * Math.sin(th),
    z: L.R * (Math.cos(th) - 1) - a * L.back,
    ry: th * (L.turn ?? 1),
    blur: 0.75 * smooth(0.1, 0.42, a),
    // It blurs and darkens at once: with the dimming over 0.1 to 0.8, a screen at 0.43 from the front was blurred but
    // still nearly as bright as the front one.
    // In a row of phones the planes past the step's three show other phone screens of the demo (`fill` below), dimmed
    // and soft as a side screen. A copy of the step's own screens said there were five (seen 21 Nov 2026 at 1440x900),
    // and those copies faded to the page's colour read as blank cards at each edge (seen 22 Nov 2026 at 1280x720).
    dim: 0.5 * smooth(0.1, 0.5, a),
    alpha: L.strip ? 1 - smooth(2.6, 3, a) : 1 - smooth(1.2, 1.48, a),
  };
}

/** Readable: nearly opaque, nearly sharp, nearly undimmed (the same thresholds the design step measured with). */
export const readable = (s) => s.alpha > 0.9 && s.blur < 0.3 && s.dim < 0.25;

/** The four corners of a screen on the floor (CSS px from the floor's top left), as three.js's camera draws them. */
export function quad(P, L) {
  const dist = camDist(L.H);
  const x0 = L.cx - L.W / 2 + P.x;
  const y0 = L.H / 2 - L.cy;
  const c = Math.cos(P.ry);
  const s = Math.sin(P.ry);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const lx = (sx * L.w) / 2;
    const x = x0 + lx * c;
    const y = y0 + (sy * L.h) / 2;
    const z = P.z - lx * s;
    const k = dist / (dist - z);
    return [L.W / 2 + x * k, L.H / 2 - y * k];
  });
}

/**
 * Which screen the ring shows at progress `p` (0 to 1) of a step's pin: each screen is held for a stretch and the
 * change between two takes `change` of the pin (eased, so it starts and ends slowly). Returns 0 to n - 1.
 */
export function ringT(p, n = 3, change = 0.14) {
  const hold = (1 - change * (n - 1)) / n;
  const q = clamp(p);
  const i = Math.min(n - 1, Math.floor(q / (hold + change)));
  const r = q - i * (hold + change);
  if (i >= n - 1 || r <= hold) return i;
  return i + smooth(0, 1, (r - hold) / change);
}

/**
 * Every screen of the ring at `t`, with its corners, far ones first (the order they are drawn). `i` is the screen,
 * `slot` the plane that draws it (a row of phones has nine), `fill` true for a plane past the step's three in a row of
 * phones: it shows another screen of the demo (story-data.mjs rowFill), never one of the step's.
 */
export function ringState(t, L, n = 3) {
  const all = copies(L).flatMap((m, c) => Array.from({ length: n }, (_, i) => { const P = pose(i - t + n * m, L, n); return { i, slot: c * n + i, fill: m !== 0, ...P, quad: quad(P, L), readable: readable(P) }; }));
  // Painter's order: far first; at a tie the leaving one goes under the coming one.
  return all.sort((a, b) => (a.z - (a.d > 0 ? 0 : 1)) - (b.z - (b.d > 0 ? 0 : 1)));
}

/** The box around a quad: [left, top, right, bottom]. */
export const box = (q) => [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];

const inside = (pt, q) => {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [x1, y1] = q[k];
    const [x2, y2] = q[(k + 1) % 4];
    const c = (x2 - x1) * (pt[1] - y1) - (y2 - y1) * (pt[0] - x1);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
};

/**
 * The share of the window under the bar that is empty: 16 px cells covered neither by the words' box nor by a screen
 * that can be seen (opacity over 0.2; a shadow and the floor's grid count as empty). `screens` are boxes of the
 * window ({ quad, alpha } in window px), `words` the words' box [left, top, right, bottom], `top` the bar's bottom.
 */
export function emptyShare({ screens, words, W, H, top }) {
  let cells = 0;
  let filled = 0;
  for (let y = top + 8; y < H; y += 16) for (let x = 8; x < W; x += 16) {
    cells++;
    if (words && x >= words[0] && x <= words[2] && y >= words[1] && y <= words[3]) filled++;
    else if (screens.some((s) => s.alpha > 0.2 && inside([x, y], s.quad))) filled++;
  }
  return cells ? 1 - filled / cells : 0;
}

/** Two screens both readable where they overlap on the window: the one thing a change must never show. */
export function twoReadable(states) {
  const r = states.filter((s) => s.readable);
  for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
    const A = box(r[a].quad);
    const B = box(r[b].quad);
    if (Math.min(A[2], B[2]) > Math.max(A[0], B[0]) && Math.min(A[3], B[3]) > Math.max(A[1], B[1])) return true;
  }
  return false;
}

/**
 * How far a pinned step has run, 0 when its stage reaches the bar (`stickyTop`) and 1 when the stage is let go at
 * the step's end: from the step's own position, so scrolling back plays it backwards.
 */
export function pinProgress(stepTop, stepHeight, stageHeight, stickyTop) {
  const run = stepHeight - stageHeight;
  if (run <= 0) return 0;
  return clamp((stickyTop - stepTop) / run);
}

/** The picture size for a front screen `w` CSS px wide at pixel ratio `dpr`: a texel about one device pixel. */
export const frontSize = (w, dpr) => (w * Math.min(dpr || 1, 2) > 1088 * 1.15 ? 2176 : 1088);
