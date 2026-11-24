// The seal's net refusal as ES-module exports; its one copy is tools/seal-net.cjs (what it holds is said there).
import { createRequire } from 'node:module';

export const { shippedGateways, defaultPorts, extraPorts, refusePorts } = createRequire(import.meta.url)('./seal-net.cjs');
