import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/stocks/$symbol")({
  component: StockDetail,
});

function StockDetail() {
  const { symbol } = Route.useParams();
  return (
    <PagePlaceholder
      title={symbol.toUpperCase()}
      description="Price history, risk profile, portfolio fit and buy simulation."
    />
  );
}
