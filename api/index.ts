// Vercel compiles this file on its own into an ES module and leaves its imports as written. Node will not resolve the
// server's extensionless imports ("../server/_core/index"), so the function would crash on load. Import the server
// bundle that `pnpm build` writes with esbuild instead: one file, every relative import already inlined.
// @ts-ignore -- built output, no type declarations
import { app } from "../dist/index.js";
export default app;
