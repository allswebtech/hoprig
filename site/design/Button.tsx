// Buttons and links that look like buttons. One look for both, so a later account area's actions match the site's.
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type Look = 'primary' | 'plain' | 'quiet';
const cls = (look: Look, small?: boolean, extra?: string) => ['btn', look === 'primary' ? 'btn-primary' : look === 'quiet' ? 'btn-quiet' : '', small ? 'btn-small' : '', extra || ''].filter(Boolean).join(' ');

export function Button({ look = 'plain', small, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { look?: Look; small?: boolean; children: ReactNode }) {
  return <button type="button" className={cls(look, small, className)} {...rest}>{children}</button>;
}

export function ButtonLink({ look = 'plain', small, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { look?: Look; small?: boolean; children: ReactNode }) {
  return <a className={cls(look, small, className)} {...rest}>{children}</a>;
}
