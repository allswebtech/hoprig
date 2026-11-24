'use client';
// Loads the story's moving form (story-motion/scene.mjs and three.js) after the page has loaded and the browser is
// idle, only once the visitor scrolls and the story comes near, only with WebGL, and never when reduced motion is asked
// for (also when that is asked for later: the motion stops and the still story stays). Without it the still story is
// the whole story.
import { useEffect } from 'react';

function webgl() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function StoryMotion() {
  useEffect(() => {
    const story = document.querySelector<HTMLElement>('[data-story]');
    if (!story) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let stop: (() => void) | null = null;
    let ended = false;
    let io: IntersectionObserver | null = null;
    const end = () => { stop?.(); stop = null; };
    const begin = () => {
      if (io || ended || reduce.matches || !webgl()) return;
      io = new IntersectionObserver(async (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io?.disconnect();
        try {
          const { start } = await import('./story-motion/scene.mjs');
          if (ended || reduce.matches) return;
          const phone = matchMedia('(max-width: 699px)').matches;
          stop = await start({ story, phone, onSlow: (ms) => { end(); story.dataset.still = `slow ${ms.toFixed(0)} ms`; }, onError: () => { end(); story.dataset.still = 'error'; } });
          if (ended || reduce.matches) end();
        } catch {
          end(); // no WebGL after all, or a picture did not load: the still story stays
        }
      }, { rootMargin: '100% 0px' });
      io.observe(story);
    };
    const onReduce = () => { if (reduce.matches) end(); };
    reduce.addEventListener('change', onReduce);
    // Not before the visitor scrolls: the story stands right under the first screen, so "near" alone would fetch the
    // 3D code (about 130 KB) for everyone, also for someone who reads only the first screen. A page opened already
    // scrolled (back, or a link to a part of it) counts as scrolled.
    const arm = () => { if (scrollY > 0) begin(); else addEventListener('scroll', begin, { once: true, passive: true }); };
    // After the first screen has painted and the page has loaded: the 3D code never competes with the first screen.
    const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(arm, { timeout: 2000 }) : setTimeout(arm, 300));
    if (document.readyState === 'complete') idle();
    else addEventListener('load', idle, { once: true });
    return () => { ended = true; io?.disconnect(); end(); reduce.removeEventListener('change', onReduce); removeEventListener('load', idle); removeEventListener('scroll', begin); };
  }, []);
  return null;
}
