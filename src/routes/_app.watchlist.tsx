import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/watchlist")({
  component: () => (
    <PagePlaceholder title="Watchlist" description="Stocks you are tracking before committing capital." />
  ),
});
