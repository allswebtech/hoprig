// The root of every page: the document, the design system's styles, and the theme chosen before the first paint.
// The public pages add their header and footer in app/(site)/, so a later area with another frame can sit beside
// them under the same root and the same design system.
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_SCRIPT } from '../design/theme-script';
import '../design/tokens.css';
import '../design/kit.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://hoprig.com'),
  title: 'Hoprig',
  icons: { icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/icon.svg', type: 'image/svg+xml' }], apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f6f7fb' }, { media: '(prefers-color-scheme: dark)', color: '#0d0f17' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before anything paints: a saved dark choice is dark from the first frame (data-theme changes before React). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
