import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/portfolios/")({
  component: () => (
    <PagePlaceholder
      title="Portfolios"
      description="Create, edit and analyse individual portfolios."
    />
  ),
});
