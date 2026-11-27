// A test that makes up a Linux or macOS computer pins the platform the kit data reads for its defaults (a few kits are
// on by default on Linux and macOS and optional on Windows), so it holds on every system the tests run on.
const real = Object.getOwnPropertyDescriptor(process, 'platform');

/** Makes process.platform say `p`; returns the function that puts the real one back. */
export function pinPlatform(p) {
  Object.defineProperty(process, 'platform', { ...real, value: p });
  return () => Object.defineProperty(process, 'platform', real);
}

/** Runs fn with the platform pinned to `p`, and puts the real one back after it (also when fn throws). */
export async function withPlatform(p, fn) {
  const back = pinPlatform(p);
  try {
    return await fn();
  } finally {
    back();
  }
}
