// The frame of every public page: the header (with the page's place in the menu), the page in <main>, the footer
// (with this page's Markdown twin and where its text is edited), and the page's small scripts.
import type { ReactNode } from 'react';
import { Footer } from './Footer';
import { Header } from './Header';
import { PageScripts } from './PageScripts';
import type { Page } from './site-pages';
import './frame.css';
import './pages.css';

function Edit({ edit }: { edit: Page['edit'] }) {
  if (edit.made) {
    return <>This page is made at every build from {edit.made.map(([name, href], i) => <span key={name}>{i ? ' and ' : ''}<a href={href}>{name}</a></span>)}, with the commands&apos; help texts.</>;
  }
  return <><a href={edit.href}>Edit this page on GitHub</a> ({edit.file}).</>;
}

export function Frame({ page, className, children }: { page: Pick<Page, 'url' | 'mdUrl' | 'edit'>; className?: string; children: ReactNode }) {
  return (
    <>
      <Header current={page.url} />
      <main id="main" className={className}>{children}</main>
      <Footer mdUrl={page.mdUrl} edit={<Edit edit={page.edit} />} />
      <PageScripts />
    </>
  );
}
