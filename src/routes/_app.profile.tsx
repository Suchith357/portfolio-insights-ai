import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app/profile")({
  component: () => (
    <PagePlaceholder title="Profile" description="Account details and workspace preferences." />
  ),
});
