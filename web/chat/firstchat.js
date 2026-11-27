// The first chat of a new install (web/firstrun.js starts it): its box says what to do, and its foot keeps to the box,
// Send and the mode. Remembered in this browser until the first message is sent. Nothing here touches the server.
const KEY = 'hoprig.firstChat';

/** The words of the empty box in the first chat. */
export const FIRST_PLACEHOLDER = 'Tell Claude what to make, for example: a web page with a clock';
/** The same in a box too narrow for the example (a phone): the first half stands alone. */
export const FIRST_PLACEHOLDER_SHORT = 'Tell Claude what to make';
/** The widest box, in px, that still gets the short words (the long ones need about 460 px of box at the page's font). */
export const NARROW_BOX = 460;

const store = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

/** Called by the first-run card just before it opens the chat. */
export function markFirstChat() {
  try {
    store()?.setItem(KEY, '1');
  } catch {
    /* no storage: the chat is an ordinary one */
  }
}

/** True while the first message of the first chat has not been sent. */
export const isFirstChat = () => {
  try {
    return store()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/** The first message was sent: from now on the chat is an ordinary one. */
export function doneFirstChat() {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}
