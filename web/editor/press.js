// A list that is drawn again on its own (git's state every few seconds, a folder read) must not be drawn under a press:
// the press would land on a row that is gone, and nothing would happen. While a pointer is down on `el`, `paint` waits
// and runs once the press has ended (after its click).

/** Returns paint(), to call instead of the list's own: it draws now, or right after the press. */
export function holdWhilePressed(el, draw) {
  let pressing = false;
  let waiting = false;
  el.addEventListener('pointerdown', () => {
    pressing = true;
    const done = () => {
      pressing = false;
      document.removeEventListener('pointerup', done, true);
      document.removeEventListener('pointercancel', done, true);
      if (waiting) {
        waiting = false;
        setTimeout(draw, 0); // after the click that ends this press
      }
    };
    document.addEventListener('pointerup', done, true);
    document.addEventListener('pointercancel', done, true);
  });
  return () => {
    if (pressing) waiting = true;
    else draw();
  };
}
