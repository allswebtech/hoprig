// The story's moving form, over the still one. Each step is one stage pinned under the bar (story.css): the step's
// words as a band at the top and, under them to the window's bottom, its floor, where three.js draws the step's three
// screens of the demo on a slow ring (ring.mjs): the one in front faces the visitor at full size and sharp, the
// others stand turned at its sides, darker and soft, cut by the window's edges. Scrolling through the pin turns the
// ring by one screen at a time. Each step's floor box holds its own canvas (hidden from screen readers, never takes a
// click), under the step's words and never over them, at any width: the box comes after the words in the stage, so
// its top is the words' bottom. The canvas moves with its stage, so a stage that scrolls in or out costs no drawing.
// The words and the still pictures stay in the page (see-through, still read by a screen reader); this only adds
// motion.
//
// Sharp: the renderer draws at the device's pixel ratio (up to 2), the pictures are sRGB with mipmaps and the
// highest anisotropy, no tone mapping, and the camera stands so a unit is a CSS pixel at the front screen's depth;
// the front screen's picture is taken at its size (story-shots.mjs: 1088 or 2176 px wide), so a texel is about one
// device pixel. Nothing fades, fogs or tints the front screen: the blur and the dimming are for the others.
//
// Calm: nothing is drawn while the page rests (the frame loop sleeps until a scroll, a resize, a theme change or a
// picture wakes it), nor while a stage only scrolls with its ring standing. Where the window cannot hold the frame
// rate (1/24 s, judged on the frames drawn while a ring turns: pace.mjs), the moving frames go lean first, and only
// when those are slow too does onSlow end this, and the still story stays.
import { Color, Mesh, NoToneMapping, PerspectiveCamera, PlaneGeometry, SRGBColorSpace, Scene, ShaderMaterial, TextureLoader, Vector2, WebGLRenderer } from 'three';
import { frameLoop, paceLadder, softwareRenderer, warmQueue } from './pace.mjs';
import { focusHandler, keepPlace, showPane } from './progress.mjs';
import { FOV, box as boxOf, camDist, frontSize, layout, pinProgress, ringState, ringT } from './ring.mjs';

// The bar's bottom: the stage is pinned there (story.css: top 61px).
const BAR = 61;

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
// A screen: its picture in a rounded box with a 1 px border, a soft shadow under it, a blur (from the mipmaps) and a
// dimming toward the page's background for the screens not in front. `taps`: 5 samples for the blur, or 1 (lean).
const FRAG = `
uniform sampler2D map; uniform vec2 size; uniform float margin, radius, blur, dim, alpha, shadow, taps; uniform vec3 bg, border; uniform vec2 uvScale, uvOffset;
varying vec2 vUv;
float box(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec4 samp(vec2 uv) {
  if (blur < 0.002) return texture(map, uv, -0.5);
  float lod = blur * 3.4;
  if (taps < 2.0) return textureLod(map, uv, lod * 1.25);
  vec2 o = exp2(lod) * 0.8 / vec2(textureSize(map, 0));
  vec4 c = textureLod(map, uv, lod) * 0.36;
  c += (textureLod(map, uv + o, lod) + textureLod(map, uv - o, lod) + textureLod(map, uv + vec2(o.x, -o.y), lod) + textureLod(map, uv + vec2(-o.x, o.y), lod)) * 0.16;
  return c;
}
void main() {
  vec2 p = (vUv - 0.5) * (size + 2.0 * margin);
  float d = box(p, size * 0.5, radius);
  if (d > 0.0) {
    float s = 1.0 - smoothstep(0.0, margin, box(p + vec2(0.0, 14.0), size * 0.5, radius));
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadow * s * s * alpha);
    return;
  }
  vec2 uv = (p / size + 0.5) * uvScale + uvOffset;
  vec3 c = samp(uv).rgb;
  // The outline after the dimming: a screen turning in or away keeps a crisp edge while its contents are soft, so it
  // reads as a screen that turns, not a smudge (seen with the edge dimmed away too, mid-change at 1440x900).
  // A dark part (a terminal) is dimmed far less than a light one: dimmed toward the light page as much as the rest, a
  // blurred terminal turned into a flat mid-grey slab (seen 21 Nov 2026 mid-change at 1440x900, light). The texel is
  // linear here: the terminal's dark is about 0.01, the page's light about 0.93.
  c = mix(c, bg, min(dim, 0.5) * mix(0.15, 1.0, smoothstep(0.02, 0.4, dot(c, vec3(0.2126, 0.7152, 0.0722)))));
  c = mix(c, border, smoothstep(-1.6, -0.4, d));
  gl_FragColor = vec4(c, alpha);
  #include <colorspace_fragment>
}`;

const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

export async function start({ story, onSlow, onError = () => {} }) {
  const ratio = () => Math.min(devicePixelRatio || 1, 2);
  // One renderer for each step, its canvas in the step's floor box. No antialias: a screen's edges are drawn by its
  // shader (the rounded box), inside the plane, never by its geometry.
  const renderer = (box) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'story-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const r = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    r.setPixelRatio(ratio());
    r.toneMapping = NoToneMapping;
    r.outputColorSpace = SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    box.append(canvas);
    return r;
  };
  let aniso = 1;
  const loader = new TextureLoader();
  const load = (url) => loader.loadAsync(url).then((t) => { t.colorSpace = SRGBColorSpace; t.anisotropy = aniso; return t; });
  const colours = { bg: new Color(), border: new Color() };
  const retint = () => {
    const css = getComputedStyle(document.documentElement);
    colours.bg.set(css.getPropertyValue('--bg').trim() || '#f6f7fb');
    colours.border.set(css.getPropertyValue('--border-strong').trim() || '#dcdfeb');
    colours.shadow = dark() ? 0.5 : 0.13;
  };
  retint();

  let stopped = false;
  let wake = () => {};
  let movedAt = -Infinity; // when a ring last turned
  const warm = warmQueue({ busy: () => performance.now() - movedAt < 300 });
  const steps = [...story.querySelectorAll('.step')].map((li) => {
    const floor = li.querySelector('.floor');
    const names = [...floor.querySelectorAll('[data-pane]')].map((p) => p.dataset.pane);
    const phones = floor.classList.contains('floor-tall');
    const scene = new Scene();
    // A plane for each screen, and on a wide floor of phones nine (ring.mjs copies): the step's three in the middle and
    // other phone screens of the demo past them (li data-row-fill, story-data.mjs rowFill), one picture each.
    const meshes = Array.from({ length: names.length * (phones ? 3 : 1) }, () => {
      const material = new ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
        uniforms: { map: { value: null }, size: { value: new Vector2(1, 1) }, margin: { value: 56 }, radius: { value: 12 }, blur: { value: 0 }, dim: { value: 0 }, alpha: { value: 1 },
          shadow: { value: colours.shadow }, taps: { value: 5 }, bg: { value: colours.bg }, border: { value: colours.border }, uvScale: { value: new Vector2(1, 1) }, uvOffset: { value: new Vector2(0, 0) } },
      });
      const mesh = new Mesh(new PlaneGeometry(1, 1), material);
      scene.add(mesh);
      return mesh;
    });
    const box = li.querySelector('.step-floor');
    const gl = renderer(box);
    aniso = gl.capabilities.getMaxAnisotropy();
    return {
      li, floor, names, scene, meshes, box, gl,
      stage: li.querySelector('.step-stage'),
      words: li.querySelector('.step-words'),
      items: [...li.querySelectorAll('.step-screens li')],
      labels: [...li.querySelectorAll('.step-screens li')].map((x) => x.textContent),
      phones,
      fill: li.dataset.rowFill ? li.dataset.rowFill.split(',') : [],
      // The order the ring shows the screens in on a floor higher than wide (a phone): indexes into names.
      phoneOrder: li.dataset.phoneOrder ? li.dataset.phoneOrder.split(',').map((n) => names.indexOf(n)) : null,
      perm: '',
      camera: new PerspectiveCamera(FOV, 1, 1, 40000),
      t: -1, drawnT: undefined, now: -1, key: '', want: '', geo: '', sig: '',
    };
  });

  /** The pictures a step needs for its form: the demo at phone width on a floor higher than wide, else the front size. */
  const want = (s, L) => {
    const theme = dark() ? 'dark' : 'light';
    const kind = s.phones ? '' : L.form === 'tall' ? '-phone' : `-${frontSize(L.w, devicePixelRatio)}`;
    const tall = kind === '-phone';
    // On a phone a step may show another screen in a pane's place (story-data.mjs phoneSwap, named on its caption).
    const pic = (n, i) => (tall && s.items[i]?.dataset.phoneName) || n;
    const urls = s.names.map((n, i) => `/story/${pic(n, i)}-${theme}${kind}.webp`);
    // A row of phones: its planes in slot order (ring.mjs ringState), the other screens of the demo at both ends.
    if (!L.strip || s.fill.length !== 2 * s.names.length) return { key: theme + kind, urls };
    const fill = s.fill.map((n) => `/story/${n}-${theme}-phone.webp`);
    return { key: `${theme}${kind}-row`, urls: [...fill.slice(0, s.names.length), ...urls, ...fill.slice(s.names.length)] };
  };
  async function ensure(s, need) {
    s.want = need.key;
    if (s.key === need.key || s.loading === need.key) return;
    s.loading = need.key;
    try {
      const tex = await Promise.all(need.urls.map(load));
      if (stopped || s.want !== need.key) { for (const t of tex) t.dispose(); return; }
      for (const t of new Set(s.meshes.map((m) => m.material.uniforms.map.value))) t?.dispose();
      s.meshes.forEach((m, i) => { m.material.uniforms.map.value = tex.length === s.meshes.length ? tex[i] : tex[i % tex.length]; });
      s.key = need.key;
      s.geo = ''; // the crop follows the picture
      // Its pictures on the graphics card and its shader built before its first frame, one at a time while no ring
      // turns: a step's first frame did it all at once, at the start of each step.
      const live = () => !stopped && s.key === need.key;
      warm.add(...tex.map((t) => () => { if (live()) s.gl.initTexture(t); }), () => { if (live()) s.gl.compile(s.scene, s.camera); });
      wake();
    } catch (e) {
      if (!stopped) onError(e); // a picture did not load: the still story comes back
    } finally {
      if (s.loading === need.key) s.loading = '';
    }
  }
  // A step far from the window gives its pictures back (each is up to 12 MB on the graphics card).
  const drop = (s) => {
    if (!s.key && !s.loading) return;
    s.want = s.key = s.loading = '';
    for (const t of new Set(s.meshes.map((m) => m.material.uniforms.map.value))) t?.dispose();
    for (const m of s.meshes) m.material.uniforms.map.value = null;
  };

  /** Sizes the step's planes and crops their pictures for the layout `L` (only when it changed). */
  function fit(s, L) {
    const key = `${L.w}x${L.h}:${s.key}`;
    if (s.geo === key) return;
    s.geo = key;
    const margin = L.W < 700 ? 28 : 56;
    for (const m of s.meshes) {
      m.geometry.dispose();
      m.geometry = new PlaneGeometry(L.w + 2 * margin, L.h + 2 * margin);
      const u = m.material.uniforms;
      u.size.value.set(L.w, L.h);
      u.margin.value = margin;
      u.radius.value = L.form === 'wide' ? 12 : 14;
      // A phone screen is shown from its top, as much as the box holds: the part the step is about is at the top.
      const img = u.map.value?.image;
      const frac = img ? Math.min(1, L.h / L.w / (img.height / img.width)) : 1;
      u.uvScale.value.set(1, frac);
      u.uvOffset.value.set(0, 1 - frac);
    }
  }

  /** The ring of step `s` at `t` (0 to 2), on its layout `L`; returns the box of the screen nearest the front. */
  function pose(s, L, t, taps) {
    fit(s, L);
    // The ring's place k shows the screen order[k]: on a phone a step may show its screens in an order of its own, and
    // its screen names follow (a flex order, so the HTML keeps the step's own order).
    const order = L.form === 'tall' && s.phoneOrder ? s.phoneOrder : s.names.map((_, i) => i);
    if (s.perm !== order.join()) {
      s.perm = order.join();
      s.now = -1;
      order.forEach((i, k) => { s.items[i].style.order = String(k); });
      s.items.forEach((li, i) => { li.textContent = (L.form === 'tall' && li.dataset.phoneLabel) || s.labels[i]; });
    }
    const n = s.names.length;
    for (const m of s.meshes) m.visible = false; // a plane no copy of this layout uses
    let near = null;
    ringState(t, L, n).forEach((st, k) => {
      if (!near || Math.abs(st.d) < Math.abs(near.d)) near = st;
      const m = s.meshes[st.slot - st.i + order[st.i]];
      m.position.set(st.x, L.H / 2 - L.cy, st.z);
      m.rotation.set(0, st.ry, 0);
      m.renderOrder = k;
      const u = m.material.uniforms;
      u.blur.value = st.blur;
      u.dim.value = st.dim;
      u.alpha.value = st.alpha;
      u.shadow.value = colours.shadow;
      u.taps.value = taps;
      m.visible = st.alpha > 0.004;
    });
    const now = Math.round(Math.min(Math.max(t, 0), n - 1));
    if (now !== s.now) {
      s.now = now;
      s.frontName = s.names[order[now]]; // the still strip opens on it if the motion ends (showPane)
      s.items.forEach((li, i) => (i === order[now] ? li.setAttribute('data-now', '') : li.removeAttribute('data-now')));
    }
    return boxOf(near.quad);
  }

  let visible = true;
  // The frame-rate ladder (pace.mjs paceLadder): full frames (the device's pixel ratio, the five-tap blur) while they
  // hold 1/24 s; when they are slow, lean moving frames (the pixel ratio × 0.5, a one-tap blur) and one sharp frame when
  // the ring rests; when the lean frames are slow too, the still story (onSlow). Measured 20 Nov 2026 on software WebGL
  // at 1440x900: full frames about 217 ms.
  // A software renderer (SwiftShader, llvmpipe) starts lean: its full frames took 67 to 117 ms, and the first turn of
  // the ring was drawn at 12 to 15 frames a second before the ladder judged them.
  const glc = steps[0]?.gl.getContext();
  const info = glc?.getExtension('WEBGL_debug_renderer_info');
  const software = !!glc && softwareRenderer(info ? glc.getParameter(info.UNMASKED_RENDERER_WEBGL) : glc.getParameter(glc.RENDERER));
  if (software) story.dataset.motionLean = 'software';
  const pace = paceLadder({ lean: software, onLean: (ms) => { story.dataset.motionLean = ms.toFixed(0); }, onSlow });
  let last = 0; // the time of the last frame drawn while the ring turns, 0 after any other frame
  let tint = 0; // counts theme changes: a new theme redraws every step
  const size = new Vector2();
  /** One frame: false when nothing moved since the last one drawn (the loop then sleeps until woken). */
  function draw(time) {
    if (!visible) { last = 0; return false; }
    const vh = innerHeight;
    const views = [];
    let turning = false;
    for (const s of steps) {
      const fr = s.box.getBoundingClientRect();
      const W = Math.round(fr.width);
      const H = Math.round(fr.height);
      const L = layout({ W, H, phones: s.phones });
      // Its pictures one step ahead (a step's pin is about 3.6 windows long), given back when two steps away.
      if (fr.top < 4.5 * vh && fr.bottom > -4.5 * vh) ensure(s, want(s, L)); else drop(s);
      if (fr.bottom <= 0 || fr.top >= vh || W < 2 || H < 2 || !s.key) continue;
      const li = s.li.getBoundingClientRect();
      // Each screen held for a stretch of the pin, the change between two short (ring.mjs ringT).
      const target = ringT(pinProgress(li.top, li.height, s.stage.offsetHeight, BAR), s.names.length);
      // Eased toward the scroll's place (a wheel's step is a jump), and snapped when it is there.
      s.t = s.t < 0 ? target : s.t + (target - s.t) * 0.25;
      if (Math.abs(target - s.t) < 0.002) s.t = target;
      // Turning: the ring moved since it was last drawn (a first drawing, a resize or a new picture is not).
      if (s.drawnT !== undefined && s.t !== s.drawnT) turning = true;
      views.push({ s, W, H, L });
    }
    if (turning) movedAt = time;
    // Lean while the ring turns and for 150 ms after it stops (a slow scroll is many small turns), then one sharp frame.
    const thin = pace.lean && time - movedAt < 150;
    // × 0.5: at × 0.6 the lean frames took 33 to 50 ms here (load 7 to 8), at the edge of the rule.
    const pr = thin ? ratio() * 0.5 : ratio();
    const taps = thin ? 1 : 5;
    let drew = false;
    for (const { s, W, H, L } of views) {
      // A stage that only scrolls (its ring standing) moves with the page: nothing to draw.
      const sig = `${W}x${H}:${s.key}:${s.t.toFixed(4)}:${tint}:${pr}:${taps}`;
      if (sig === s.sig) continue;
      s.sig = sig;
      s.drawnT = s.t;
      const front = pose(s, L, s.t, taps).map(Math.round).join(',');
      if (s.li.dataset.ring !== s.t.toFixed(3)) s.li.dataset.ring = s.t.toFixed(3);
      // The front screen as drawn ([left, top, right, bottom], CSS px of the floor box): a browser check reads it beside
      // the floor box (seen 21 Nov 2026: numbers from a table of boxes passed while 700x900 drew the screen 340 px low).
      if (s.li.dataset.front !== front) s.li.dataset.front = front;
      if (s.gl.getPixelRatio() !== pr) s.gl.setPixelRatio(pr);
      s.gl.getSize(size);
      if (size.x !== W || size.y !== H) s.gl.setSize(W, H, false);
      s.camera.aspect = W / H;
      s.camera.position.set(0, 0, camDist(H));
      s.camera.updateProjectionMatrix();
      s.gl.render(s.scene, s.camera);
      drew = true;
    }
    // Only frames drawn while a ring turns are judged, each against the one drawn just before it.
    if (drew && turning) {
      const judged = last ? pace.frame(time - last) : null;
      last = time;
      if (judged) story.dataset.motionFrameMs = judged.median.toFixed(1);
    } else last = 0;
    return turning || thin || drew;
  }

  const io = new IntersectionObserver((e) => { visible = e.some((x) => x.isIntersecting); if (visible) wake(); }, { rootMargin: '20% 0px' });
  io.observe(story);
  const retheme = () => { retint(); tint++; wake(); };
  const media = matchMedia('(prefers-color-scheme: dark)');
  const poke = () => wake();
  window.addEventListener('themechange', retheme);
  media.addEventListener('change', retheme);
  addEventListener('scroll', poke, { passive: true });
  addEventListener('resize', poke);
  // A keyboard focus on a step's screens shows its first screen held, not the middle of a change; a click leaves it.
  const onFocus = focusHandler({ steps, on: () => story.dataset.motion === 'on', bar: BAR });
  for (const s of steps) s.floor.addEventListener('focus', onFocus);
  keepPlace(story, () => { story.dataset.motion = 'on'; });
  // The first steps' pictures before the first frame (the stages are in their place now that the motion is on).
  const vh0 = innerHeight;
  await Promise.all(steps.map((s) => {
    const fr = s.box.getBoundingClientRect();
    if (!(fr.top < 4.5 * vh0 && fr.bottom > -4.5 * vh0)) return null;
    return ensure(s, want(s, layout({ W: Math.round(fr.width), H: Math.round(fr.height), phones: s.phones })));
  }));
  // A frame that throws ends the motion (onError): the still story comes back rather than see-through screens.
  const stopLoop = frameLoop(draw, { onError });
  wake = stopLoop.wake;

  return () => {
    stopped = true;
    warm.stop();
    stopLoop();
    io.disconnect();
    window.removeEventListener('themechange', retheme);
    media.removeEventListener('change', retheme);
    removeEventListener('scroll', poke);
    removeEventListener('resize', poke);
    for (const s of steps) s.floor.removeEventListener('focus', onFocus);
    keepPlace(story, () => { delete story.dataset.motion; });
    // The still strip of a phone opens on the screen the moving form showed, not on its first one.
    for (const s of steps) showPane(s.floor, s.frontName);
    delete story.dataset.motionLean;
    for (const s of steps) {
      delete s.li.dataset.ring;
      delete s.li.dataset.front;
      s.items.forEach((li, i) => { li.removeAttribute('data-now'); li.style.removeProperty('order'); li.textContent = s.labels[i]; });
      for (const t of new Set(s.meshes.map((m) => m.material.uniforms.map.value))) t?.dispose();
      for (const m of s.meshes) { m.material.dispose(); m.geometry.dispose(); }
    }
    for (const s of steps) { s.gl.dispose(); s.gl.forceContextLoss(); s.gl.domElement.remove(); }
  };
}
