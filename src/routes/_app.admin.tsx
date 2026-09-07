import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PagePlaceholder } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/states";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_app/admin")({
  component: AdminPage,
});

function AdminPage() {
  const { isAdmin, ready } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (ready && !isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [ready, isAdmin, navigate]);

  if (!isAdmin) {
    return (
      <ErrorState
        variant="forbidden"
        title="Admin access required"
        description="This area is restricted to administrator accounts."
      />
    );
  }

  return (
    <PagePlaceholder
      title="Admin console"
      description="Platform statistics, user management, stock catalogue and audit log."
    />
  );
}
