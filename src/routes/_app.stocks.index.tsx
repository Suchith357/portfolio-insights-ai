import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/stocks/")({
  component: () => (
    <PagePlaceholder title="Stocks" description="Browse, search and filter the stock universe." />
  ),
});
