// Local OAuth and webhook testing needs no container, Docker image or cloud account.
import { handleLinearEdge, linearRoute, type LinearEnv } from "./linear";
export { LinearState } from "./linear";

export default {
  fetch(request: Request, env: LinearEnv): Promise<Response> | Response {
    if (!linearRoute(new URL(request.url).pathname)) return new Response("Not found", { status: 404 });
    return handleLinearEdge(request, env);
  },
};
