import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
  validateSearch: (search: Record<string, unknown>) => ({
    embed: search.embed === "1" || search.embed === 1 ? ("1" as const) : undefined,
  }),
});
