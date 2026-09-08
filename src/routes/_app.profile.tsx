import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LoadingBlock } from "@/components/common/states";
import { formatDate, initials } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_app/profile")({
  head: () => ({
    meta: [
      { title: "Profile — PortfolioIQ" },
      {
        name: "description",
        content: "Review your PortfolioIQ account details, update your name and email, or sign out.",
      },
      { property: "og:title", content: "Profile — PortfolioIQ" },
      { property: "og:description", content: "Account details and workspace preferences." },
    ],
  }),
  component: ProfilePage,
});

interface FormState {
  name: string;
  email: string;
}

function validate(form: FormState) {
  const errors: Partial<FormState> = {};
  if (form.name.trim().length < 2) errors.name = "Enter your full name (at least 2 characters).";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) errors.email = "Enter a valid email address.";
  return errors;
}

function ProfilePage() {
  const { user, ready, isAdmin, updateProfile, logout } = useAuth();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>({ name: "", email: "" });
  const [errors, setErrors] = useState<Partial<FormState>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (user) setForm({ name: user.name, email: user.email });
  }, [user]);

  if (!ready) return <LoadingBlock label="Loading your profile" />;
  if (!user) return null;

  function reset() {
    if (user) setForm({ name: user.name, email: user.email });
    setErrors({});
    setSubmitError(null);
    setEditing(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setSubmitError(null);
    setSaved(false);
    try {
      await updateProfile({ name: form.name.trim(), email: form.email.trim().toLowerCase() });
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "We couldn't save your changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    await logout();
    void navigate({ to: "/login" });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">Your account details and workspace access.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-1">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary">
              {initials(user.name)}
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <Separator className="my-4" />
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Role</dt>
              <dd>
                <Badge variant={isAdmin ? "default" : "outline"}>{user.role}</Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Account status</dt>
              <dd className="font-medium">{user.status}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Member since</dt>
              <dd className="num font-medium">{formatDate(user.createdAt)}</dd>
            </div>
          </dl>
          <Separator className="my-4" />
          <Button variant="outline" className="w-full" onClick={handleLogout}>
            <LogOut className="mr-1.5 h-4 w-4" />
            Sign out
          </Button>
        </section>

        <section className="panel p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Account details</h2>
              <p className="text-sm text-muted-foreground">Update the name and email used across PortfolioIQ.</p>
            </div>
            {!editing && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit profile
              </Button>
            )}
          </div>

          {saved && !editing && (
            <p className="mt-4 flex items-center gap-2 rounded-md border border-gain/40 bg-gain/10 px-3 py-2 text-sm text-gain">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Your profile has been updated.
            </p>
          )}

          <form onSubmit={submit} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">Full name</Label>
                <Input
                  id="profile-name"
                  value={form.name}
                  disabled={!editing || saving}
                  aria-invalid={!!errors.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-email">Email address</Label>
                <Input
                  id="profile-email"
                  type="email"
                  value={form.email}
                  disabled={!editing || saving}
                  aria-invalid={!!errors.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
                {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
              </div>
            </div>

            {submitError && <p className="text-sm text-destructive">{submitError}</p>}

            {editing && (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
                <Button type="button" variant="ghost" onClick={reset} disabled={saving}>
                  Cancel
                </Button>
              </div>
            )}
          </form>

          <p className="mt-6 text-xs text-muted-foreground">
            Role and account status are managed by an administrator and cannot be changed here.
          </p>
        </section>
      </div>
    </div>
  );
}
