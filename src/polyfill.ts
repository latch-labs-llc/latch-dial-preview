// Must be the FIRST import of main.tsx. ES imports are hoisted, so assigning
// Buffer inside main.tsx would run only after every dependency evaluated and
// any module-scope Buffer use would blank the production bundle. As its own
// module, this evaluates before the rest of the import graph.
import { Buffer } from "buffer";
(globalThis as any).Buffer = (globalThis as any).Buffer ?? Buffer;
