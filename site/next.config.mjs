// hoprig.com as a Next.js app exported to plain files (GitHub Pages serves them; there is no server).
// Every address ends in a slash (/docs/install/ is docs/install/index.html), as the old generator made them.
// Images are not optimised by Next: the pictures are made at their shown sizes by the site's own scripts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  // site/ is the app's root (the product's own lock one folder up is not this app's).
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  reactStrictMode: true,
  // The build may be pointed at a folder of its own (a test builds into a temporary one).
  distDir: process.env.SITE_NEXT_DIST || '.next',
};

export default config;
