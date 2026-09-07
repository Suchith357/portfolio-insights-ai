import { Link, createFileRoute } from "@tanstack/react-router";
import { BarChart3, LineChart, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PortfolioIQ — Portfolio Risk & Diversification Analyzer" },
      {
        name: "description",
        content:
          "PortfolioIQ analyses stock portfolios for risk, diversification and sector concentration, with plain-language explanations of every computed metric.",
      },
      { property: "og:title", content: "PortfolioIQ — Portfolio Risk & Diversification Analyzer" },
      {
        property: "og:description",
        content: "Analyse portfolio risk, diversification and sector concentration with explainable analytics.",
      },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    icon: BarChart3,
    title: "Portfolio analytics",
    body: "Risk score, diversification score, sector concentration and annualised volatility computed from the dataset.",
  },
  {
    icon: ShieldCheck,
    title: "Buy & sell simulation",
    body: "See how a hypothetical trade would change your portfolio before recording anything real.",
  },
  {
    icon: Sparkles,
    title: "Explainable insights",
    body: "Every explanation describes numbers produced by the analytics engine — no invented figures.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <LineChart className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Portfolio<span className="text-primary">IQ</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/register">Get started</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-20">
        <section className="py-16 sm:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            Portfolio intelligence
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Understand the risk hiding inside your stock portfolio.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
            PortfolioIQ measures concentration, volatility and diversification across your holdings, simulates trades
            before you make them, and explains each result in plain language.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/login">Open the dashboard</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/register">Create an account</Link>
            </Button>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Runs on a synthetic academic dataset. Not live market data and not investment advice.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="panel p-5">
              <Icon className="h-5 w-5 text-primary" aria-hidden />
              <h2 className="mt-3 text-base font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
