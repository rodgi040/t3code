import { createRouter, RouterHistory } from "@tanstack/react-router";

import { BASE_PATH } from "./basePath";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    defaultPreload: "intent",
    ...(BASE_PATH === "" ? {} : { basepath: BASE_PATH }),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
