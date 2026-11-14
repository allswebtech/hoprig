#!/usr/bin/env node
// Stands in for `claude setup-token` in tests. It prints what Claude Code 2.1.325 prints (recorded from the real
// CLI on a Mac and on Linux up to the sign-in link: cursor jumps between words, an OSC 8 hyperlink, the paste
// prompt), then — past the point that could be recorded without a real sign-in — what the binary's strings say
// it prints on success ("Long-lived authentication token created successfully", the token) or on a bad code.
// FAKE_CLAUDE_MODE: "normal" (default) | "nolink" (never shows a link) | "exit" (exits at once)
import fs from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE || 'normal';
if (process.argv[2] !== 'setup-token') {
  process.stdout.write('fake claude: only setup-token\n');
  process.exit(2);
}
// Report the environment it got (the test checks that no account credential reached it).
if (process.env.FAKE_CLAUDE_ENV_FILE) {
  const keys = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(k));
  fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_FILE, JSON.stringify({ keys, browser: process.env.BROWSER, configDir: process.env.CLAUDE_CONFIG_DIR }));
}
if (mode === 'exit') {
  process.stdout.write('Error: something went wrong\n');
  process.exit(1);
}
const w = (s) => process.stdout.write(s);
w('\x1b[?25l\x1b[?2004h\x1b[38;5;174mWelcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24G\x1b[38;5;246mv2.1.325\x1b[39m\r\n\r\n');
w('\x1b[2G\x1b[1mThis\x1b[7Gwill\x1b[12Gguide\x1b[18Gyou\x1b[22Gthrough\x1b[30Glong-lived\x1b[41G(1-year)\x1b[50Gauth\x1b[55Gtoken\x1b[61Gsetup\x1b[22m\r\n\r\n');
w('\x1b[2G·\x1b[4GOpening\x1b[12Gbrowser\x1b[20Gto\x1b[23Gsign\x1b[28Gin…\r\n');
if (mode === 'nolink') {
  setInterval(() => w('\r\x1b[1C\x1b[1A✻\r\n'), 200);
} else {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcDEF123&code_challenge_method=S256&state=xyz789';
  setTimeout(() => {
    w("\r\x1b[1C\x1b[1A\x1b[38;5;246mBrowser didn't open? Use the url below to sign in (c to copy)\x1b[39m\r\n\r\n");
    w(`\x1b]8;id=1mo4kuu;${url}\x07\x1b[38;5;246m${url}\x1b[39m\x1b]8;;\x07\r\n\r\n\r\n`);
    w('\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\n');
  }, 300);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    const i = buf.search(/[\r\n]/);
    if (i < 0) return;
    const code = buf.slice(0, i).trim();
    buf = '';
    if (!code.includes('#')) {
      w('\x1b[2G\x1b[38;5;210mInvalid code. Please make sure the full code was copied\x1b[39m\r\n');
      return;
    }
    if (code.startsWith('expired')) {
      w('\x1b[2GOAuth error: Request failed with status code 400\r\n');
      return;
    }
    w('\x1b[2G\x1b[38;5;114m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\n');
    w('\x1b[2GYour\x1b[7GOAuth\x1b[13Gtoken\x1b[19G(valid\x1b[26Gfor\x1b[30G1\x1b[32Gyear):\r\n\r\n');
    w('\x1b[2G\x1b[38;5;220msk-ant-oat01-FAKEtokenFAKEtokenFAKEtoken_0123456789abcdefABCDEF-xyzAA\x1b[39m\r\n\r\n');
    w("\x1b[2G\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n");
    setTimeout(() => process.exit(0), 200);
  });
}
