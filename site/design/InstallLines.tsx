// The install lines of the three systems, one under another: what to press to open that system's terminal, then its
// line with the Copy button. The group is id="install" (where the header's Install leads); a script of the page may set
// data-first to the visitor's system, and the kit's CSS then shows that system first. Without it Windows is first.
import { InstallLine } from './InstallLine';

export type InstallSystem = { id: string; name: string; open: string; command: string };

export function InstallLines({ systems, id = 'install' }: { systems: readonly InstallSystem[]; id?: string }) {
  return (
    <div className="installs" id={id} data-installs>
      {systems.map((s) => (
        <div className="install-system" key={s.id} data-system={s.id}>
          <p className="install-how"><strong>{s.name}</strong>: {s.open}.</p>
          <InstallLine command={s.command} id={`${id}-${s.id}`} />
        </div>
      ))}
    </div>
  );
}
