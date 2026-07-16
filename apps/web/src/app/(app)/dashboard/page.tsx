'use client';

import { ArrowDownRight, ArrowUpRight, Sparkles, TrendingUp, Users, Wallet } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, Skeleton, cn } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { formatMoney, useLeads } from '@/features/leads/use-leads';

/**
 * A single headline number.
 *
 * The delta is the point. "Revenue: ₹4,20,000" tells an owner almost nothing on
 * its own — the question they actually have is "is that good?", and the only
 * answer is "compared to what". So the comparison is not an optional garnish;
 * it is the content.
 */
function StatTile({
  label,
  value,
  delta,
  icon,
  loading,
}: {
  label: string;
  value: string;
  delta?: number;
  icon: React.ReactNode;
  loading?: boolean;
}) {
  const positive = (delta ?? 0) >= 0;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-subtle">{label}</span>
        <span className="text-subtle">{icon}</span>
      </div>

      {loading ? (
        <Skeleton className="mt-3 h-7 w-24" />
      ) : (
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-tight tabular">{value}</span>

          {delta !== undefined && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-[12px] font-medium',
                positive ? 'text-success' : 'text-danger',
              )}
            >
              {positive ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {Math.abs(delta)}%
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Placeholder revenue series.
 *
 * Labelled as such rather than passed off as real. There is no Sales module yet,
 * so there is no revenue to chart — and a dashboard that invents numbers is
 * worse than one that admits it has none, because the invented ones get believed
 * and acted on.
 */
const REVENUE_SERIES = [
  { month: 'Feb', revenue: 210_000 },
  { month: 'Mar', revenue: 285_000 },
  { month: 'Apr', revenue: 240_000 },
  { month: 'May', revenue: 340_000 },
  { month: 'Jun', revenue: 395_000 },
  { month: 'Jul', revenue: 420_000 },
];

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);

  // Real data. The leads endpoint is live, so these tiles are genuine.
  const { data, isLoading } = useLeads({ sortBy: 'aiScore', sortOrder: 'desc' });

  const leads = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const qualified = leads.filter((lead) => lead.status === 'QUALIFIED').length;
  const hot = leads.filter((lead) => (lead.aiScore ?? 0) >= 70).length;

  const pipelineValue = leads.reduce(
    (sum, lead) => sum + Number(lead.estimatedValue ?? 0),
    0,
  );

  const topLead = leads.find((lead) => lead.aiScore !== null);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {/* Greeting by first name. Small touch, but it is the difference
              between software that feels like a tool and software that feels
              like a colleague. */}
          Good to see you, {user?.firstName}
        </h1>
        <p className="mt-0.5 text-[13px] text-subtle">Here is where your business stands today.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total leads"
          value={String(total)}
          icon={<Users className="h-4 w-4" />}
          loading={isLoading}
        />
        <StatTile
          label="Qualified"
          value={String(qualified)}
          icon={<TrendingUp className="h-4 w-4" />}
          loading={isLoading}
        />
        <StatTile
          label="Hot (AI ≥ 70)"
          value={String(hot)}
          icon={<Sparkles className="h-4 w-4" />}
          loading={isLoading}
        />
        <StatTile
          label="Pipeline value"
          value={formatMoney(String(pipelineValue))}
          icon={<Wallet className="h-4 w-4" />}
          loading={isLoading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Revenue</h2>
            {/* Honest labelling. See the note on REVENUE_SERIES. */}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-subtle">
              Sample data
            </span>
          </div>
          <p className="mb-4 text-[12px] text-subtle">
            Wired up for real once the Sales module lands.
          </p>

          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={REVENUE_SERIES} margin={{ left: -20, right: 4, top: 4 }}>
                <defs>
                  <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                  </linearGradient>
                </defs>

                {/* Horizontal gridlines only. Vertical ones add ink without
                    adding information — the x-axis labels already mark them. */}
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--border))"
                />

                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 12, fill: 'hsl(var(--subtle))' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 12, fill: 'hsl(var(--subtle))' }}
                  tickFormatter={(value: number) => `${value / 1000}k`}
                />

                <Tooltip
                  cursor={{ stroke: 'hsl(var(--border))' }}
                  contentStyle={{
                    background: 'hsl(var(--surface))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                  formatter={(value: number) => [formatMoney(String(value)), 'Revenue']}
                />

                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="hsl(var(--accent))"
                  strokeWidth={2}
                  fill="url(#revenueFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* The AI insight panel. This is the product's whole promise in one
            card: not "here is your data", but "here is what to do next". */}
        <Card className="flex flex-col p-5">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold">AI insight</h2>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : topLead?.aiScoreReason ? (
            <div className="space-y-3">
              <div>
                <p className="text-[13px] font-medium">
                  {topLead.firstName} {topLead.lastName}
                  {topLead.companyName && (
                    <span className="text-subtle"> · {topLead.companyName}</span>
                  )}
                </p>
                <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[12px] font-medium text-success">
                  <Sparkles className="h-3 w-3" />
                  {topLead.aiScore}
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-subtle">{topLead.aiScoreReason}</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col justify-center">
              <p className="text-[13px] leading-relaxed text-subtle">
                No AI insights yet. Add an{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-[12px]">ANTHROPIC_API_KEY</code>{' '}
                to your <code className="rounded bg-muted px-1 py-0.5 text-[12px]">.env</code> and
                Nexora will start scoring leads and surfacing what needs your attention.
              </p>
              <p className="mt-3 text-[12px] text-subtle/70">
                Everything else works without it — AI is additive, never required.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
