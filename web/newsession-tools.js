// New session: what a coding tool's terminal may do without asking.

/**
 * What another tool's terminal may do without asking, as POST /api/sessions takes it: 'ask' unless the owner chose
 * otherwise (OpenCode's own defaults allow almost everything, so they are only an explicit choice, said plainly).
 * New session offers no choice of it any more (the chat and Settings do): a start there always asks first.
 */
export const terminalMode = (v) => (v === 'own' ? null : v === 'bypassPermissions' ? 'bypassPermissions' : 'ask');
