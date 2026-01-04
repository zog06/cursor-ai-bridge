"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BarChart3, RefreshCw, AlertCircle, CheckCircle2, Plus } from "lucide-react";
import { AccountsData, AccountLimitsResponse, AccountLimit } from "./types";
import { AccountLimitsModal } from "./account-limits-modal";

interface AccountStatusCardProps {
  accounts: AccountsData;
}

interface AccountUsage {
  anthropic: number | null;
  anthropicModels: { name: string; percentage: number; resetTime: string | null }[];
  anthropicResetTime: string | null;
  google: number | null;
  googleModels: { name: string; percentage: number; resetTime: string | null }[];
  googleResetTime: string | null;
}

function calculateUsage(account: AccountLimit, models: string[]): AccountUsage {
  const anthropicList: { name: string; percentage: number; resetTime: string | null }[] = [];
  const googleList: { name: string; percentage: number; resetTime: string | null }[] = [];
  let anthropicSum = 0;
  let googleSum = 0;
  let anthropicValidCount = 0;
  let googleValidCount = 0;

  for (const model of models) {
    const limit = account.limits[model];
    if (!limit) continue;

    // Even if remainingFraction is null (exhausted), we want to show it
    const percentage = limit.remainingFraction !== null ? Math.round(limit.remainingFraction * 100) : 0;

    if (model.includes("claude") || model.includes("sonnet") || model.includes("opus")) {
      anthropicList.push({ name: model, percentage, resetTime: limit.resetTime });
      if (limit.remainingFraction !== null) {
        anthropicSum += limit.remainingFraction;
        anthropicValidCount++;
      }
    } else if (model.includes("gemini")) {
      // Only show Gemini 3 models
      if (!model.includes("3")) {
        continue;
      }
      googleList.push({ name: model, percentage, resetTime: limit.resetTime });
      if (limit.remainingFraction !== null) {
        googleSum += limit.remainingFraction;
        googleValidCount++;
      }
    }
  }

  const anthropicAvg = anthropicValidCount > 0
    ? Math.round((anthropicSum / anthropicValidCount) * 100)
    : (anthropicList.length > 0 ? 0 : null);

  const googleAvg = googleValidCount > 0
    ? Math.round((googleSum / googleValidCount) * 100)
    : (googleList.length > 0 ? 0 : null);

  // Find the earliest reset time for exhausted models
  const anthropicResetTime = anthropicList
    .filter(m => m.percentage === 0 && m.resetTime)
    .sort((a, b) => new Date(a.resetTime!).getTime() - new Date(b.resetTime!).getTime())[0]?.resetTime || null;

  const googleResetTime = googleList
    .filter(m => m.percentage === 0 && m.resetTime)
    .sort((a, b) => new Date(a.resetTime!).getTime() - new Date(b.resetTime!).getTime())[0]?.resetTime || null;

  return {
    anthropic: anthropicAvg,
    anthropicModels: anthropicList,
    anthropicResetTime,
    google: googleAvg,
    googleModels: googleList,
    googleResetTime
  };
}

export function AccountStatusCard({ accounts }: AccountStatusCardProps) {
  const [showLimitsModal, setShowLimitsModal] = useState(false);
  const [limitsData, setLimitsData] = useState<AccountLimitsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchLimits = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/account-limits");
      if (!response.ok) {
        throw new Error("Failed to fetch account limits");
      }
      const json = await response.json();
      setLimitsData(json);
      setLastUpdated(new Date());
    } catch (error) {
      console.error("Failed to fetch account limits:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAccount = async (email: string, disabled: boolean) => {
    try {
      const response = await fetch("/api/accounts/toggle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, disabled }),
      });
      if (response.ok) {
        fetchLimits();
      } else {
        console.error("Failed to toggle account status");
      }
    } catch (error) {
      console.error("Error toggling account status:", error);
    }
  };

  const handleAddAccount = async () => {
    try {
      const response = await fetch("/api/auth/start");
      const data = await response.json();
      if (data.status === "success" && data.url) {
        window.open(data.url, "_blank");
      } else {
        console.error("Failed to start auth flow:", data.message);
      }
    } catch (error) {
      console.error("Error starting auth flow:", error);
    }
  };

  // Fetch on mount and every 5 minutes
  useEffect(() => {
    fetchLimits();
    const interval = setInterval(fetchLimits, 5 * 60 * 1000); // 5 minutes
    return () => clearInterval(interval);
  }, []);

  const getStatusBadge = (account: AccountLimit) => {
    if (account.isDisabled) {
      return (
        <Badge variant="secondary" className="h-5 text-xs font-medium px-2 py-0 opacity-50">
          Disabled
        </Badge>
      );
    }
    if (account.status === "ok") {
      return (
        <Badge variant="default" className="h-5 text-xs font-medium px-2 py-0 bg-green-500/10 text-green-600 border-none hover:bg-green-500/20">
          Active
        </Badge>
      );
    } else if (account.status === "invalid") {
      return (
        <Badge variant="destructive" className="h-5 text-xs font-medium px-2 py-0">
          Invalid
        </Badge>
      );
    } else {
      return (
        <Badge variant="outline" className="h-5 text-xs font-medium px-2 py-0">
          {account.status}
        </Badge>
      );
    }
  };

  const getUsageColor = (usage: number | null) => {
    if (usage === null) return "text-muted-foreground";
    if (usage > 50) return "text-green-500";
    if (usage > 20) return "text-yellow-500";
    return "text-red-500";
  };

  const formatRemainingTime = (resetTime: string | null) => {
    if (!resetTime) return null;
    const now = new Date();
    const reset = new Date(resetTime);
    const diffMs = reset.getTime() - now.getTime();
    if (diffMs <= 0) return "Soon";

    const minutes = Math.floor(diffMs / 60000);
    const seconds = Math.floor((diffMs % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  };

  return (
    <>
      <Card className="border-border/40">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Account Status</CardTitle>
              <CardDescription>
                {lastUpdated && `Last updated: ${lastUpdated.toLocaleTimeString()}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddAccount}
                className="gap-1.5"
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={fetchLimits}
                disabled={loading}
                className="h-8 w-8"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                <span className="sr-only">Refresh</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowLimitsModal(true)}
                className="gap-1.5"
              >
                <BarChart3 className="h-4 w-4" />
                Limits
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Summary Stats */}
            <div className="flex gap-8 px-1 pb-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Available</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">{accounts.available}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Limited</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight text-destructive/90">{accounts.rateLimited}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Disabled</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight text-muted-foreground/60">{accounts.disabled}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Invalid</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight text-muted-foreground/40">{accounts.invalid}</span>
              </div>
            </div>

            {/* Account List */}
            {limitsData && (
              <div className="space-y-2">
                {limitsData.accounts.map((account, idx) => {
                  const usage = calculateUsage(account, limitsData.models);
                  return (
                    <div
                      key={idx}
                      className={`rounded-lg border transition-colors ${account.isDisabled
                          ? "bg-muted/30 border-border/50 opacity-50"
                          : "bg-card border-border shadow-sm hover:border-muted-foreground/30"
                        }`}
                    >
                      {/* Account Header */}
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={!account.isDisabled}
                            onCheckedChange={(checked) => handleToggleAccount(account.email, !checked)}
                          />
                          <span className={`text-sm font-mono truncate transition-colors ${account.isDisabled ? "text-muted-foreground/50" : "text-foreground font-medium"
                            }`}>
                            {account.email}
                          </span>
                        </div>
                        {getStatusBadge(account)}
                      </div>

                      {/* Usage Section (only if active) */}
                      {account.status === "ok" && !account.isDisabled && (
                        <div className="p-3 pt-0 grid grid-cols-2 gap-6">
                          {/* Anthropic */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground uppercase tracking-wider">
                              <div className="flex items-center gap-1.5">
                                <span>Anthropic</span>
                                {usage.anthropic === 0 && usage.anthropicResetTime && (
                                  <span className="text-xs text-destructive/80 lowercase font-normal">
                                    (resets in {formatRemainingTime(usage.anthropicResetTime)})
                                  </span>
                                )}
                              </div>
                              <span className={getUsageColor(usage.anthropic)}>
                                {usage.anthropic !== null ? `${usage.anthropic}%` : "-"}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {usage.anthropicModels.map((m, i) => (
                                <div key={i} className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground truncate mr-2">
                                    {m.name.replace('claude-3-5-', '').replace('claude-3-', '')}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <div className="w-12 h-1 bg-muted rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${m.percentage < 20 ? 'bg-red-500' : 'bg-primary'}`}
                                        style={{ width: `${m.percentage}%` }}
                                      />
                                    </div>
                                    <span className={`text-[11px] tabular-nums ${m.percentage === 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                                      {m.percentage === 0 && m.resetTime ? `in ${formatRemainingTime(m.resetTime)}` : `${m.percentage}%`}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Google */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground uppercase tracking-wider">
                              <div className="flex items-center gap-1.5">
                                <span>Google</span>
                                {usage.google === 0 && usage.googleResetTime && (
                                  <span className="text-xs text-destructive/80 lowercase font-normal">
                                    (resets in {formatRemainingTime(usage.googleResetTime)})
                                  </span>
                                )}
                              </div>
                              <span className={getUsageColor(usage.google)}>
                                {usage.google !== null ? `${usage.google}%` : "-"}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {usage.googleModels.map((m, i) => (
                                <div key={i} className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground truncate mr-2">
                                    {m.name}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <div className="w-12 h-1 bg-muted rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${m.percentage < 20 ? 'bg-red-500' : 'bg-primary'}`}
                                        style={{ width: `${m.percentage}%` }}
                                      />
                                    </div>
                                    <span className={`text-[11px] tabular-nums ${m.percentage === 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                                      {m.percentage === 0 && m.resetTime ? `in ${formatRemainingTime(m.resetTime)}` : `${m.percentage}%`}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {account.error && (
                        <div className="p-2 border-t border-destructive/10 bg-destructive/5">
                          <div className="flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                            <span className="text-sm text-destructive leading-tight">{account.error}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!limitsData && !loading && (
              <div className="text-center py-4 text-sm text-muted-foreground">
                No account limits data available
              </div>
            )}

            {loading && !limitsData && (
              <div className="flex items-center justify-center py-4">
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AccountLimitsModal
        open={showLimitsModal}
        onOpenChange={setShowLimitsModal}
      />
    </>
  );
}
