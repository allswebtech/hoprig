// The session page's own controls around its terminal (the bar, the quick keys, the key bar, the message box, a limit's
// box) carry one attribute, so a page that shows the terminal alone (the editor's terminal panel, web/editor/terminal.js)
// hides them by that attribute and not by class names that change with the page.
export const CHROME = 'data-chrome';
/** The attribute for an element: "bar" (always hidden in a panel) or "keys" (the key bar: a touch screen keeps it). */
export const chrome = (kind = 'bar') => ({ [CHROME]: kind });
