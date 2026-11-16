// What still streams in a chat: text and thinking blocks being written (their deltas joined), and tool calls being
// written or running (their title and elapsed time). A page that connects in the middle of a reply gets these with
// the chat's state; each goes when its final event is in the numbered list.
const TEXT_MAX = 200_000; // of one block

export class LiveBlocks extends Map {
  /** text-delta, thinking-delta, tool-start, tool-progress */
  add(ev) {
    if (ev.kind === 'text-delta' || ev.kind === 'thinking-delta') {
      const b = this.get(ev.blockId) || { kind: ev.kind === 'text-delta' ? 'text' : 'thinking', blockId: ev.blockId, text: '', agent: ev.agent };
      b.text = (b.text + ev.text).slice(-TEXT_MAX);
      if (ev.tokens !== undefined) b.tokens = ev.tokens;
      this.set(ev.blockId, b);
      return;
    }
    const key = `tool:${ev.id}`;
    const t = this.get(key) || { kind: 'tool', id: ev.id, agent: ev.agent };
    if (ev.kind === 'tool-start') Object.assign(t, { name: ev.name, title: ev.title || t.title || '', toolKind: ev.toolKind });
    else t.elapsedS = ev.elapsedS;
    this.set(key, t);
  }

  /** A final event came: text and thinking take the place of their block; a tool call stays (it runs) until its result. */
  final(ev) {
    if (ev.kind === 'text' || ev.kind === 'thinking') this.delete(ev.blockId);
    else if (ev.kind === 'tool') {
      const t = this.get(`tool:${ev.id}`);
      if (t) {
        // Written whole: it runs from now on (the status line says what, and for how long).
        t.written = true;
        t.runAt = Date.now();
        if (ev.title) t.title = ev.title;
        const cmd = ev.input && typeof ev.input.command === 'string' ? ev.input.command.split('\n').find((l) => l.trim()) : '';
        if (cmd) t.command = cmd.slice(0, 200);
      }
    } else if (ev.kind === 'tool-result') this.delete(`tool:${ev.id}`);
  }

  /** The turn ended: nothing it wrote streams any more (a tool call that runs on in the background stays). */
  turnEnded() {
    for (const [k, v] of this) if (v.kind !== 'tool' || !v.written) this.delete(k);
  }
}
