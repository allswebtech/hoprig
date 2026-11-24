// Whether the window holds the story's frame rate, judged all the time it moves, not only at its start: the first
// frames come before the costly part of the scroll (seen: 16.7 ms over the first 90 frames, then a median of 50 ms
// with a floor in view). The median of the last `size` drawn frames is judged every `every` frames.
export function slowWatch({ size = 60, every = 30, limit = 1000 / 24 } = {}) {
  const times = [];
  let n = 0;
  /** One drawn frame's time; returns { median, slow } at each judgement, else null. */
  return (ms) => {
    times.push(ms);
    if (times.length > size) times.shift();
    n++;
    if (times.length < size || n % every) return null;
    const median = [...times].sort((a, b) => a - b)[Math.floor(size / 2)];
    return { median, slow: median > limit };
  };
}

/** A renderer that draws WebGL on the CPU (its name from WEBGL_debug_renderer_info or RENDERER). */
export const softwareRenderer = (name) => /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(String(name || ''));

/**
 * The frame-rate ladder: full frames while they hold the rule; when they are slow (the median of 3 frames, judged
 * every 3: measured 20 Nov 2026, the first full frames of 67 to 117 ms were 0.3 to 0.7 s of jank at every load on
 * software WebGL, judged over 6), lean frames (onLean); when the lean frames are slow too (the median of the last 60,
 * judged every 30, the whole time it moves), the still story (onSlow). `lean: true` starts with lean frames: a
 * software renderer, whose full frames are always too slow. `frame(ms)` takes the time of one frame drawn while the
 * story moves and returns the judgement, if one was made.
 */
export function paceLadder({ onLean = () => {}, onSlow = () => {}, limit = 1000 / 24, lean: leanFirst = false } = {}) {
  let lean = leanFirst;
  let watch = lean ? slowWatch({ limit }) : slowWatch({ size: 3, every: 3, limit });
  return {
    get lean() { return lean; },
    frame(ms) {
      const judged = watch(ms);
      if (!judged?.slow) return judged;
      if (!lean) {
        lean = true;
        watch = slowWatch({ limit });
        onLean(judged.median);
      } else onSlow(judged.median);
      return judged;
    },
  };
}

/**
 * Runs `draw(t)` once a frame until the returned stop() is called, also when `draw` itself calls it (the motion ends
 * from inside a frame when the window is slow): a stopped loop asks for no new frame. Seen 20 Nov 2026 with the CPU
 * slowed 6x: after the still story came back, the loop went on measuring the floors, drawing into the disposed
 * renderer and judging the frame rate. A frame that throws ends the loop and goes to `onError`.
 *
 * A `draw` that returns false had nothing to draw: the loop then sleeps (asks for no frame) until stop.wake() is
 * called, by a scroll, a resize or a picture that arrived. Nothing is drawn while the page rests: on a computer with
 * software WebGL a frame of the story costs most of a CPU.
 */
export function frameLoop(draw, { onError = () => {}, raf = requestAnimationFrame, cancel = cancelAnimationFrame } = {}) {
  let id = 0;
  let stopped = false;
  let asleep = false;
  const frame = (t) => {
    id = 0;
    let more;
    try {
      more = draw(t);
    } catch (e) {
      stopped = true;
      onError(e);
      return;
    }
    if (stopped) return;
    if (more === false) asleep = true;
    else id = raf(frame);
  };
  id = raf(frame);
  const stop = () => {
    stopped = true;
    if (id) cancel(id);
    id = 0;
  };
  stop.wake = () => {
    if (stopped || !asleep || id) return;
    asleep = false;
    id = raf(frame);
  };
  return stop;
}

/**
 * A queue of small jobs that prepare a step's drawing before it comes into view (its pictures sent to the graphics
 * card, its shader built), one job per idle moment, and only while `busy()` is false (no ring turning): a job that
 * finds the page busy waits (`retry`) and tries again. Without it a step's first frame did all of that at once: measured
 * 21 Nov 2026 on software WebGL, 200 to 417 ms frames at each step's start, the uploads 41 to 77 ms of it.
 */
export function warmQueue({ busy = () => false, idle = (f) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f) : setTimeout(f, 50)), retry = (f) => setTimeout(f, 250) } = {}) {
  const jobs = [];
  let waiting = false;
  let stopped = false;
  const next = () => {
    waiting = false;
    if (stopped || !jobs.length) return;
    if (busy()) { waiting = true; retry(() => { waiting = false; schedule(); }); return; }
    jobs.shift()();
    schedule();
  };
  const schedule = () => {
    if (stopped || waiting || !jobs.length) return;
    waiting = true;
    idle(next);
  };
  return {
    add(...more) { jobs.push(...more); schedule(); },
    stop() { stopped = true; jobs.length = 0; },
  };
}
