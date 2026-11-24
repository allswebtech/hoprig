// The moving story (scene.mjs, plain JavaScript over three.js), as the page sees it.
export function start(options: { story: HTMLElement; phone?: boolean; onSlow: (msPerFrame: number) => void; onError?: (error: unknown) => void }): Promise<() => void>;
