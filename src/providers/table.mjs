// A closed table that names every way a provider stops the coding tool's work, from what Claude Code writes in
// its records: the StopFailure hook's `error`, and the transcript line's apiErrorType, apiErrorStatus,
// stop_reason and the message text. The rows were read from the real Claude Code (2.1.328) against a gateway
// stand-in on 2026-11-19 (docs/PROVIDERS.md keeps the samples). What matches no row is `provider-error` with
// the tool's own line, cut short, never guessed at.
//
// `classify` names a stop only from the tool's own fields (a StopFailure's `error`, a transcript line's status, type
// or `refusal` stop); the words only tell apart stops that those fields leave alike. With no such field it returns
// null, so a failed test, a command's non-zero exit, a tool result that says "error" or the model's prose is no stop.

import { redact } from '../assistant/secrets.mjs';

const CUT = 160;
const STATUS = /^API Error:\s*(\d{3})\b/;
// A gateway's error body is outside the product's control and may be very long. Only the first part of it is read:
// the words the rows look for come first, only CUT characters are kept, and so no row's pattern ever runs on more.
const READ = 600;
const oneLine = (s) => String(s ?? '').slice(0, READ * 4).replace(/\s+/g, ' ').trim().slice(0, READ);
// The cut never splits a character: a lone half of an emoji before the ellipsis would show as a broken sign.
// What is kept and shown is cleaned first: a gateway puts the key, the account and the Authorization header into its
// error line. The product's cleaner masks keys and tokens; an account's e-mail address is masked here as well.
// The address may start only where a run of its characters starts, and each part is bounded: on a long line of word
// characters (a base64 blob in a gateway's body) an open pattern is tried again at every character, and the hook runs
// past the 5 seconds Claude Code gives it. Only the first CLEAN_MAX characters are cleaned: no more is ever shown.
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const CLEAN_MAX = 4000;
export const cleanLine = (s) => redact(String(s ?? '').slice(0, CLEAN_MAX)).replace(EMAIL, '***');
const clean = cleanLine;
const clip = (s) => (s.length > CUT ? `${s.slice(0, CUT - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : s);

// The step that recovers each name. It is an abstract hint; the attention item maps it to an act the product
// already has, and adds no act of its own.
//   switch   continue on the next provider (a usage limit only)
//   signin   open the provider's page and sign in again
//   name     open the provider's page and make the model name known (a MODELS entry, or a combo at the gateway)
//   gateway  restart the gateway
//   session  open the session (nothing the product may do by a rule mends it)
export const REASONS = Object.freeze({
  limit: { step: 'switch', retriable: false, words: 'a usage limit' },
  auth: { step: 'signin', retriable: false, words: 'the sign-in is gone' },
  model: { step: 'name', retriable: false, words: 'the endpoint refuses this model name' },
  input: { step: 'session', retriable: false, words: 'the model does not take this kind of input' },
  refusal: { step: 'session', retriable: false, words: 'the provider refused the request' },
  'no-answer': { step: 'gateway', retriable: true, words: 'the endpoint did not answer' },
  server: { step: 'session', retriable: true, words: 'the provider failed past its retries' },
  'provider-error': { step: 'session', retriable: false, words: 'a provider error' },
});

export const NAMES = Object.freeze(Object.keys(REASONS));

/**
 * Name what stopped the work, or null when it is not a provider stop.
 * `record`: { error, status, type, stop, text } — Claude Code's StopFailure `error`, and the transcript line's
 * apiErrorStatus, apiErrorType, stop_reason and last_assistant_message / text.
 * Returns { reason, step, retriable, words, text } where `text` is the tool's own line, cleaned and cut short.
 */
export function classify(record = {}) {
  const error = oneLine(record.error).toLowerCase();
  const type = oneLine(record.type).toLowerCase();
  const stop = oneLine(record.stop).toLowerCase();
  const text = oneLine(record.text);
  // The hook keeps no HTTP status, but the tool's own line starts with it ("API Error: 500 …"): an endpoint that
  // answered with a status is never named by the words that follow it.
  const status = Number(record.status) || Number(STATUS.exec(text)?.[1]) || null;
  const name = (reason) => ({ reason, ...REASONS[reason], text: clip(clean(text)) });

  // Only the tool's own fields say that a provider stopped the work. Words alone never do: a model's prose, a
  // failed test or a log line can hold "timed out", "can't help with this" or "model not found".
  const signal = (error && error !== 'none') || status || type || stop === 'refusal';
  if (!signal) return null;
  // The provider's own check refused the request: never reworded, moved or retried. Claude Code marks it with a
  // `refusal` stop reason in the transcript, and its StopFailure says `invalid_request` with the provider's words.
  if (stop === 'refusal') return name('refusal');
  // A usage limit, or out of credit.
  if (error === 'rate_limit' || error === 'billing_error' || type === 'rate_limit_error' || status === 429) return name('limit');
  // A sign-in that is gone.
  if (error === 'authentication_failed' || error === 'oauth_org_not_allowed' || type === 'authentication_error' || status === 401 || status === 403) return name('auth');
  if (error === 'model_not_found') return name('model');
  // The endpoint turned the request down (a 400 or 404, or a StopFailure that says `invalid_request` or only
  // `unknown`): here the words tell which. An ambiguous model name at a gateway comes as `unknown` with a 400.
  const turnedDown = [400, 404, 422].includes(status) || type === 'invalid_request_error' || type === 'not_found_error'
    || ((error === 'invalid_request' || error === 'unknown') && !status);
  if (turnedDown) {
    if (/safeguards flagged|can't help with this|\/legal\/aup\b/i.test(text)) return name('refusal');
    if (/ambiguous model|issue with the selected model|\bmodel:?\b[^.]{0,80}\b(not found|does not exist|doesn't exist)\b/i.test(text)) return name('model');
    if (/image input is not supported|input is not supported|does not support image/i.test(text)) return name('input');
  }
  // The endpoint did not answer: a gateway that hangs, is down, or the connection broke. An HTTP status means it
  // answered, so only a stop with none counts; Claude Code says `server_error` (or `unknown`) with these words.
  if (error === 'connection_failed') return name('no-answer');
  if (!status && (error === 'server_error' || error === 'unknown') && /timed out|timeout|connection refused|econnrefused|could not connect|socket hang up|network error/i.test(text)) return name('no-answer');
  // An overload or a server error that outlasted the tool's own retries.
  if (error === 'server_error' || error === 'overloaded' || type === 'overloaded_error' || type === 'api_error' || (status && status >= 500)) return name('server');
  // A stop we have no row for: the tool's own line, cut short, and nothing guessed.
  return name('provider-error');
}
