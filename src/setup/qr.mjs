// A QR code of a URL, drawn with text characters, so a phone camera can open the dashboard from the terminal.
// qrcode-terminal: small, no dependencies of its own, used for years by many CLIs; pinned to an exact version.
// Its `small` mode draws two rows per text line, so the code fits in an ordinary terminal window.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The QR code as text, or null when the package is missing (the URL is printed anyway). */
export function qrText(url) {
  let qrcode;
  try {
    qrcode = require('qrcode-terminal');
  } catch {
    return null;
  }
  let text = null;
  qrcode.generate(url, { small: true }, (s) => {
    text = s;
  });
  return text;
}
