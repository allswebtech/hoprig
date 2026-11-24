// What a search means, as text, for the page (web/editor/search.js). The server's search has the same text in
// src/editor/words.mjs (the server does not load the page's files); test/editor/search.test.mjs holds the two equal, so
// Match Whole Word finds and replaces the same words in both. Nothing here compiles a pattern.

// VS Code's Match Whole Word is ripgrep's --word-regexp, and a word character is ripgrep's \w (UTS #18, Annex C):
// Alphabetic, a combining mark (the vowel sign of "कमी", the accent of a decomposed "café"), a decimal digit, a
// connector such as "_", and the two joiners (U+200C, U+200D) that Persian and Indian scripts write inside a word.
// JavaScript's \b knows A to Z only. "m²" is the word "m": a superscript digit is not a decimal one.
export const WORD_CHAR = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';

/** Plain text as a pattern that matches exactly it. */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The source of the search's pattern (used with the "u" flag, and "i" unless case matters). */
export function patternSource({ q, regex, word }) {
  const body = regex ? q : escapeRe(q);
  return word ? `(?<!${WORD_CHAR})(?:${body})(?!${WORD_CHAR})` : body;
}
