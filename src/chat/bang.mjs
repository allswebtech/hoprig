// "!" before a line in the App: the owner runs a shell command in the session's folder, as Claude Code's shell mode
// does in its terminal (code.claude.com/docs/en/interactive-mode, "Shell mode with ! prefix"). It is a command he types
// in his own dashboard, behind its sign-in, and it runs as a command typed into the built-in terminal runs: his shell
// ($SHELL; Windows: PowerShell), the folder of the session, the dashboard's environment without its secrets
// (secretenv.mjs). Nothing goes to the coding tool here: the page puts the command and its output in front of the
// owner's next message, as text he sends himself, so the session's permission mode is neither asked nor passed by.
import { spawn } from 'node:child_process';
import { withoutSecrets } from '../secretenv.mjs';

export const COMMAND_MAX = 4000; // characters of one command line
export const OUTPUT_MAX = 64 * 1024; // what is kept of the output: its end, where a test run says how it went
export const TIME_MAX_MS = 5 * 60_000; // a command still running then is stopped

/** A command line from the page: one line or several, no NUL, at most COMMAND_MAX characters; else null. */
export function bangCommand(x) {
  if (typeof x !== 'string' || x.includes('\0')) return null;
  const t = x.replace(/^\s+|\s+$/g, '');
  return t && t.length <= COMMAND_MAX ? t : null;
}

/** The shell that runs a command line: [file, args] (an array: the line is the shell's own input, as typed). */
export function shellFor(command, platform = process.platform, env = process.env) {
  if (platform === 'win32') return ['powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command]];
  return [env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), ['-c', command]];
}

export const DRAIN_MS = 200; // after the shell ends, how long its pipes may still bring output (a child it left holds them)
// After the command is over, the pipes of a program it left running are emptied this often and what is in them is
// dropped. What it costs: a few reads a second of at most what a pipe and its stream hold (64 KB each), so a program
// that writes without pause (`yes &`) is held back by its full pipe and takes next to nothing of the dashboard's one
// thread, while a quiet one never waits, its pipe has room. A 'data' listener here instead read every chunk as it came
// and kept that thread busy until the program ended (a whole core for `yes &`).
export const SINK_MS = 250;

/**
 * Run `command` in folder `cwd` → { code (null when stopped), output (stdout and stderr as they came, its last
 * OUTPUT_MAX characters), cut (the start was dropped), timedOut, stopped (the owner stopped it), ms }.
 * It is over when the shell itself ends: a program it started in the background (`npm run dev &`) keeps running and
 * keeps nothing waiting; its output after DRAIN_MS is dropped (its pipes stay open: a write to a closed one would end
 * it). Its pipes are the dashboard's, so it lives as long as the dashboard does: after a restart its next write ends
 * it (SIGPIPE), unless its output goes elsewhere (`npm run dev > dev.log 2>&1 &`). Only a shell still running at the
 * time limit or at the owner's stop (o.signal) is ended, with its whole process group.
 * o: { timeMs, signal (AbortSignal: the owner's Stop), onOutput(text) (each piece as it comes), platform, env, spawnImpl, drainMs, sinkMs }
 */
export function runBang(cwd, command, o = {}) {
  const [file, args] = shellFor(command, o.platform, o.env || process.env);
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let cut = false;
    let timedOut = false;
    let stopped = false;
    let exited = false;
    let finished = false;
    let child;
    let drain = null;
    const take = (b) => {
      if (finished) return;
      const t = b.toString('utf8');
      out += t;
      if (out.length > OUTPUT_MAX * 2) {
        out = out.slice(-OUTPUT_MAX);
        cut = true;
      }
      o.onOutput?.(t);
    };
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drain);
      o.signal?.removeEventListener('abort', onAbort);
      if (out.length > OUTPUT_MAX) {
        out = out.slice(-OUTPUT_MAX);
        cut = true;
      }
      // A child the shell left running may hold the pipes open. They are not closed: its next write would then
      // end it (SIGPIPE). They stop flowing and are emptied every SINK_MS instead (see there); they no longer hold
      // the dashboard's event loop, and close when that child ends.
      for (const s of [child?.stdout, child?.stderr]) if (s) sink(s);
      resolve({ code, output: out, cut, timedOut, stopped, ms: Date.now() - started });
    };
    const sink = (s) => {
      s.removeListener('data', take);
      s.pause();
      const t = setInterval(() => {
        while (s.read() !== null);
      }, o.sinkMs ?? SINK_MS);
      t.unref?.();
      s.once('close', () => clearInterval(t));
      s.unref?.();
    };
    const killGroup = () => {
      if (exited) return; // the shell ended: what it left running in the background is the owner's
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = () => {
      if (exited || finished) return;
      stopped = true;
      killGroup();
    };
    try {
      child = (o.spawnImpl || spawn)(file, args, { cwd, env: withoutSecrets(o.env || process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      resolve({ code: null, output: `Could not start the shell: ${e.message}`, cut: false, timedOut: false, stopped: false, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      killGroup(); // its whole process group: a test runner's children too
    }, o.timeMs ?? TIME_MAX_MS);
    timer.unref?.();
    if (o.signal) {
      if (o.signal.aborted) queueMicrotask(onAbort);
      else o.signal.addEventListener('abort', onAbort);
    }
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => {
      take(Buffer.from(`Could not start the shell: ${e.message}\n`));
      done(null);
    });
    // The shell ended: its output is read to the end ('close'), or for DRAIN_MS where a child it left holds the pipes.
    let endCode = null;
    child.on('exit', (code) => {
      exited = true;
      endCode = timedOut || stopped ? null : code;
      drain = setTimeout(() => done(endCode), o.drainMs ?? DRAIN_MS);
    });
    child.on('close', (code) => done(exited ? endCode : timedOut || stopped ? null : code));
  });
}
