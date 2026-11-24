// The demo's stand-in for Claude Code's stored sign-in (the one a provider of the kind "login" uses): who is signed
// in, as the Providers page asks it (src/server/claudelogin.mjs, GET /api/accounts/claude-login/account), and the
// sign-in state routerstate.mjs providerFacts gives that provider. Both come from here, so the page's two answers agree,
// and the demo never starts a program to ask (the stand-in program src/demo/signin.mjs answers only setup-token).
// Made-up values only. HOPRIG_TEST_SIGNIN picks the state for the screenshots: out (default: the demo's "Claude Pro"
// is not signed in) | in (signed in as a made-up account on the Pro plan).

const ACCOUNT = { email: 'demo@example.invalid', org: 'Example', plan: 'pro' };

/** The demo's stored sign-in, kept in this process: { loggedIn, plan, email, org }. */
export function demoStoredSignin(env = process.env) {
  let signedIn = env.HOPRIG_TEST_SIGNIN === 'in';
  const now = () => (signedIn ? { loggedIn: true, ...ACCOUNT } : { loggedIn: false, plan: null, email: null, org: null });
  return {
    /** What providerFacts says of a provider that uses the stored sign-in. */
    facts: () => ({ signedIn, plan: signedIn ? ACCOUNT.plan : null, usageReported: signedIn ? true : null }),
    /** The server's sign-in check (claudeLoginFeature's `status`): no program is started. */
    status: async () => ({ ...now(), changed: false }),
    /** "Sign out": forgets the made-up sign-in in this process only. */
    logout: async () => {
      signedIn = false;
      return { ok: true };
    },
  };
}
