import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/holdings/$id")({
  component: HoldingDetail,
});

function HoldingDetail() {
  const { id } = Route.useParams();
  return (
    <PagePlaceholder
      title="Holding analysis"
      description={`Performance, contribution to risk and sell simulation for holding ${id}.`}
    />
  );
}
