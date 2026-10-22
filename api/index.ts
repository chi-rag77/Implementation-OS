import { createHostedApp } from "../apps/api/src/hosted.ts";

const app = createHostedApp();

// Vite's plain /api functions do not use Next.js catch-all file routing.
// Vercel rewrites the original API path into this explicit route parameter.
export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    const route = url.searchParams.get("__route");
    if (!route || route.startsWith("/") || route.split("/").includes(".."))
      return new Response("Not Found", { status: 404 });
    url.searchParams.delete("__route");
    url.pathname = `/api/${route}`;
    return app.fetch(new Request(url, request));
  },
};
