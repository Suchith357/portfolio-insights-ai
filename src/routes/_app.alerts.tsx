import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/alerts")({
  component: () => (
    <PagePlaceholder title="Alerts" description="Sample risk and news events affecting your holdings." />
  ),
});
