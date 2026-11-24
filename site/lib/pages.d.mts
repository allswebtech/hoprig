// Types for pages.mjs, read by the Next pages at build time (the module itself stays plain JavaScript).
export type Page = {
  url: string;
  mdUrl: string;
  file: string;
  kind: 'page' | 'list' | 'doc' | 'usecase' | 'compare' | 'tools' | string;
  data: Record<string, string | number | boolean>;
  title: string;
  description: string;
  answer: string;
  markdown: string;
  body: string;
  twin: string;
  edit: { file?: string; href?: string; made?: [string, string][] };
};
export const NAV: [string, string][];
export const DOC_GROUPS: [string, string[]][];
export const SIDE_LABELS: Record<string, string>;
export function mdUrlOf(url: string): string;
export function pageTitle(page: Page): string;
export function docGroups(pages: Page[]): [string, Page[]][];
export function useCasesOf(pages: Page[]): Page[];
export function installHtml(): string;
export function sourceOf(root: string, src: string): string;
export function linkItems(html: string): string;
export function sizeImages(html: string, fileOf: (src: string) => string, options?: { eager?: boolean }): string;
export function loadPages(root: string): Promise<Page[]>;
export function skillFiles(root: string): string[];
