// The public site's layout group: a skip link, the page in its frame (Frame.tsx: header, main, footer), and the
// header's Install jump. A later account area gets a layout group of its own beside this one and shares only the
// design system (design/).
import type { ReactNode } from 'react';
import { InstallJump } from './InstallJump';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">Skip to the content</a>
      {children}
      <InstallJump />
    </>
  );
}
