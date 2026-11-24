// Types for the parts of markdown.mjs the Next pages read (the module itself stays plain JavaScript).
export function frontMatter(text: string): { data: Record<string, string | number | boolean>; body: string };
export function renderMarkdown(text: string, options?: { link?: (href: string) => string; copy?: 'site' | 'one' }): { html: string; headings: { depth: number; text: string; id: string }[] };
export function plainText(md: string): string;
