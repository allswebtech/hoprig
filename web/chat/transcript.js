// The transcript view of the conversation (the session menu's Transcript view, as the desktop app's): Normal folds
// every call into its line and hides the thinking, Thinking shows the thinking too, Verbose opens everything with each
// turn's line. Kept in this browser for every session. The timeline (timeline.js) draws; this decides what is open.
import { viewOk } from './words.js';

const VIEW_KEY = 'chat.view';

/** The view kept in this browser, else Normal. */
export function keptView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return viewOk(v) ? v : 'normal';
  } catch {
    return 'normal';
  }
}

/** Whether a thinking block is open in view `v`: Thinking and Verbose both show it ("plus Claude's thinking"). */
export const thinkingOpen = (v) => v === 'thinking' || v === 'verbose';

/**
 * root: the timeline's element (its data-view and data-billed say the rest to the CSS); parts() → { cards, blocks }
 * (the tool cards and the text and thinking blocks drawn) → { now(), set(v), billed(on) }
 */
export function transcriptView(root, parts) {
  let view = keptView();
  root.dataset.view = view;
  return {
    now: () => view,
    /** Another view: kept for every session in this browser; every card and thinking block drawn follows it. */
    set(v) {
      if (!viewOk(v)) return;
      view = v;
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* a private window: for this page only */
      }
      root.dataset.view = v;
      const { cards, blocks } = parts();
      for (const card of cards) card.applyView(v);
      for (const b of blocks) if (b.kind === 'thinking') b.open = thinkingOpen(v);
    },
    /** Dollars are said only for a provider billed by use (words.js billed). */
    billed(on) {
      if (on) root.dataset.billed = '1';
      else delete root.dataset.billed;
    },
  };
}
