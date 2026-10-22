import { createHostedApp } from "../apps/api/src/hosted.ts";

// Vercel's Node runtime accepts a Web-standard fetch handler here.
export default { fetch: createHostedApp().fetch };
