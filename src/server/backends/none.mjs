// The backend of a dashboard that has no terminals of its own: a hub (it only shows and relays other computers),
// or a computer where neither tmux nor the terminal module (node-pty, an optional dependency) is available.
// The page works; it lists no local sessions, and starting one says why it cannot.
export class NoBackend {
  /** reason: "hub" | "missing" (neither tmux nor node-pty), `detail` the load error of node-pty if any. */
  constructor({ reason = 'hub', detail = '' } = {}) {
    this.kind = 'none';
    this.reason = reason;
    this.capabilities = { nativeScrollback: true, persistent: false };
    this.message =
      reason === 'hub'
        ? 'This computer is a hub: it shows your other computers and has no terminals of its own.'
        : `No terminal is available on this computer: install tmux, or the terminal module (run "hoprig doctor")${detail ? ` (${detail})` : ''}.`;
  }

  validName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/.test(name);
  }

  async list() {
    return [];
  }

  fail() {
    throw new Error(this.message);
  }

  async create() {
    this.fail();
  }

  attach() {
    this.fail();
  }

  async sendText() {
    this.fail();
  }

  async sendKey() {
    this.fail();
  }

  async capture() {
    return '';
  }

  async scroll() {}

  async respawn() {
    this.fail();
  }

  async rename() {
    this.fail();
  }

  async kill() {
    this.fail();
  }

  async close() {}
}
