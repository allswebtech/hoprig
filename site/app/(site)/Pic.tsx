// A story picture in the theme of the page: one <picture> whose dark <source> the system's preference picks, so the
// browser fetches only the picture it shows, also with scripts off (where a lazy <img> is fetched at once, and a
// hidden one too). A theme chosen on the switch sets that source's media: the head's script as the page is read,
// the switch afterwards (design/theme-script.ts, design/ThemeSwitch.tsx). A desktop screen has a half-size file for
// phones and small panes.
import { SHOTS } from './story-data.mjs';

export type Shot = (typeof SHOTS)[number] & { phone?: boolean; label: string };
export const shot = (name: string): Shot => {
  const s = SHOTS.find((x) => x.name === name);
  if (!s) throw new Error(`no story picture "${name}" in story-data.mjs`);
  return s as Shot;
};

const NARROW = '(max-width: 699px)';

export function Pic({ name, sizes }: { name: string; sizes: string }) {
  const s = shot(name);
  const [w, h] = s.phone ? [780, 1688] : [1280, 800];
  // The 1088 and 2176 files are the moving story's front screen (story-shots.mjs), the same 16 by 10: the still
  // story's big front screen (990 px at 1440) takes them too, so it is sharp at pixel ratio 1 and 2.
  const set = (theme: 'light' | 'dark') => (s.phone ? `/story/${s.name}-${theme}.webp` : `/story/${s.name}-${theme}-640.webp 640w, /story/${s.name}-${theme}-1088.webp 1088w, /story/${s.name}-${theme}.webp 1280w, /story/${s.name}-${theme}-2176.webp 2176w`);
  // A desktop screen also has its phone-width form (the demo at 390 px): on a narrow window the still story shows the
  // dashboard as it is on a phone, not a desktop screen shrunk to 335 px. data-width tells the theme script and the
  // switch which width the dark source is for, so a chosen theme keeps it.
  const phoneSet = (theme: 'light' | 'dark') => `/story/${s.name}-${theme}-phone.webp`;
  return (
    <picture>
      {!s.phone && <source data-dark data-width={NARROW} media={`${NARROW} and (prefers-color-scheme: dark)`} srcSet={phoneSet('dark')} width={780} height={1688} />}
      {!s.phone && <source media={NARROW} srcSet={phoneSet('light')} width={780} height={1688} />}
      <source data-dark media="(prefers-color-scheme: dark)" srcSet={set('dark')} sizes={s.phone ? undefined : sizes} width={w} height={h} />
      <img className="pic" src={`/story/${s.name}-light.webp`} srcSet={s.phone ? undefined : set('light')} sizes={s.phone ? undefined : sizes} width={w} height={h} alt={s.alt} loading="lazy" decoding="async" />
    </picture>
  );
}
