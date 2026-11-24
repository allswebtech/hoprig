// The install line: the one command, and one button that copies exactly it. id="install" is where the header's
// Install button leads; the copy button is what it focuses.
import { CopyButton } from './CopyButton';

export function InstallLine({ command, id = 'install' }: { command: string; id?: string }) {
  // A narrow window breaks the line after a "/" (a <wbr>), not in the middle of a word: seen at 390 px as "allswebt /
  // ech". The copied text is the command alone.
  const parts = command.split(/(?<=\/)/);
  return (
    <div className="install" id={id}>
      <code id={`${id}-cmd`}><span className="prompt" aria-hidden="true">$ </span>{parts.map((p, i) => (i ? [<wbr key={i} />, p] : p))}</code>
      <CopyButton text={command} target={`${id}-cmd`} />
    </div>
  );
}
