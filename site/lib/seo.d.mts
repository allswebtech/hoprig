// Types for the parts of seo.mjs the Next pages read (the module itself stays plain JavaScript).
export const INSTALL: string;
export const INSTALL_WINDOWS: string;
export const INSTALL_LINUX: string;
export const INSTALLS: readonly { id: string; name: string; open: string; command: string }[];
export const PLATFORMS: string;
export const NOT_DONE: string[];
export function jsonLd(page: object, options: { version: string }): string;
