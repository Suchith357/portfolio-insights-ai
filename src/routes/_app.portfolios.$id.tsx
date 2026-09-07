import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/portfolios/$id")({
  component: PortfolioDetail,
});

function PortfolioDetail() {
  const { id } = Route.useParams();
  return (
    <PagePlaceholder
      title="Portfolio detail"
      description={`Holdings, allocation and risk breakdown for portfolio ${id}.`}
    />
  );
}
