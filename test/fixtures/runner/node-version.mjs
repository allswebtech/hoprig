// For test/runner.test.mjs and test/setup/nodeguard.test.mjs: loaded with --import, it makes this process report the
// made-up Node.js version SEAL_FAKE_NODE names, so a check of the version can be shown without that Node installed.
if (process.env.SEAL_FAKE_NODE) Object.defineProperty(process.versions, 'node', { value: process.env.SEAL_FAKE_NODE });
