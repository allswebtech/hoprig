// A card: the dashboard's raised surface. With href it is one link (the whole card is the target).
import type { ReactNode } from 'react';
import { Icon } from './icons';

export function Card({ title, icon, href, more, children, level = 3 }: { title: string; icon?: string; href?: string; more?: string; children?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  const body = (
    <>
      {icon ? <span className="card-icon"><Icon name={icon} /></span> : null}
      <H>{title}</H>
      {children}
      {more && href ? <span className="card-more">{more}</span> : null}
    </>
  );
  return href ? <a className="card" href={href}>{body}</a> : <div className="card">{body}</div>;
}
