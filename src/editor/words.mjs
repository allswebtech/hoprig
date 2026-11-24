// Match Whole Word for the server's search: the same definition as the page's web/editor/words.js. The server does not
// load files of the page (it runs without web/ in a copy that has only bin and src), so the text is kept twice and
// test/editor/search.test.mjs holds the two equal.

// VS Code's Match Whole Word is ripgrep's --word-regexp, and a word character is ripgrep's \w (UTS #18, Annex C):
// Alphabetic, a combining mark, a decimal digit, a connector such as "_", and the two joiners (U+200C, U+200D).
export const WORD_CHAR = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';

/** Plain text as a pattern that matches exactly it. */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The source of the search's pattern (used with the "u" flag, and "i" unless case matters). */
export function patternSource({ q, regex, word }) {
  const body = regex ? q : escapeRe(q);
  return word ? `(?<!${WORD_CHAR})(?:${body})(?!${WORD_CHAR})` : body;
}
