"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BarChart3, RefreshCw, AlertCircle, CheckCircle2, Plus } from "lucide-react";
import { AccountsData, AccountLimitsResponse, AccountLimit } from "./types";
import { AccountLimitsModal } from "./account-limits-modal";

interface AccountStatusCardProps {
  accounts: AccountsData;
}

interface AccountUsage {
  anthropic: number | null;
  anthropicModels: { name: string; percentage: number }[];
  google: number | null;
  googleModels: { name: string; percentage: number }[];
}

function calculateUsage(account: AccountLimit, models: string[]): AccountUsage {
  const anthropicList: { name: string; percentage: number }[] = [];
  const googleList: { name: string; percentage: number }[] = [];
  let anthropicSum = 0;
  let googleSum = 0;

  for (const model of models) {
    const limit = account.limits[model];
    if (!limit || limit.remainingFraction === null) continue;

    const percentage = Math.round(limit.remainingFraction * 100);
    
    if (model.includes("claude") || model.includes("sonnet") || model.includes("opus")) {
      anthropicList.push({ name: model, percentage });
      anthropicSum += limit.remainingFraction;
    } else if (model.includes("gemini")) {
      // Only show Gemini 3 models
      if (!model.includes("3")) {
        continue;
      }
      googleList.push({ name: model, percentage });
      googleSum += limit.remainingFraction;
    }
  }

  const anthropicAvg = anthropicList.length > 0
    ? Math.round((anthropicSum / anthropicList.length) * 100)
    : null;

  const googleAvg = googleList.length > 0
    ? Math.round((googleSum / googleList.length) * 100)
    : null;

  return { 
    anthropic: anthropicAvg, 
    anthropicModels: anthropicList,
    google: googleAvg, 
    googleModels: googleList 
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
    if (account.status === "ok") {
      return (
        <Badge variant="default" className="gap-1 text-xs">
          <CheckCircle2 className="h-3 w-3" />
          OK
        </Badge>
      );
    } else if (account.status === "invalid") {
      return (
        <Badge variant="destructive" className="gap-1 text-xs">
          <AlertCircle className="h-3 w-3" />
          Invalid
        </Badge>
      );
    } else {
      return (
        <Badge variant="secondary" className="text-xs">
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
          <div className="space-y-3">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="flex flex-col">
                <span className="text-muted-foreground">Available</span>
                <span className="font-medium text-lg">{accounts.available}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-muted-foreground">Rate Limited</span>
                <span className="font-medium text-lg text-destructive">{accounts.rateLimited}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-muted-foreground">Invalid</span>
                <span className="font-medium text-lg text-muted-foreground">{accounts.invalid}</span>
              </div>
            </div>

            {/* Account List with Usage */}
            {limitsData && (
              <div className="pt-3 border-t border-border/40 space-y-2">
                {limitsData.accounts.map((account, idx) => {
                  const usage = calculateUsage(account, limitsData.models);
                  return (
                    <div
                      key={idx}
                      className="p-3 rounded-md bg-muted/30 border border-border/20 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono truncate flex-1">
                          {account.email}
                        </span>
                        {getStatusBadge(account)}
                      </div>

                      {account.status === "ok" && (
                        <div className="grid grid-cols-2 gap-4 pt-2">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-foreground">Anthropic</span>
                              <span className={`text-sm font-bold ${getUsageColor(usage.anthropic)}`}>
                                {usage.anthropic !== null ? `${usage.anthropic}%` : "-"}
                              </span>
                            </div>
                            <div className="space-y-0.5">
                              {usage.anthropicModels.map((m, i) => (
                                <div key={i} className="flex items-center justify-between text-[10px] text-muted-foreground opacity-60">
                                  <span className="truncate mr-2">{m.name.replace('claude-3-5-', '').replace('claude-3-', '')}</span>
                                  <span>{m.percentage}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-foreground">Google</span>
                              <span className={`text-sm font-bold ${getUsageColor(usage.google)}`}>
                                {usage.google !== null ? `${usage.google}%` : "-"}
                              </span>
                            </div>
                            <div className="space-y-0.5">
                              {usage.googleModels.map((m, i) => (
                                <div key={i} className="flex items-center justify-between text-[10px] text-muted-foreground opacity-60">
                                  <span className="truncate mr-2">{m.name}</span>
                                  <span>{m.percentage}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {account.error && (
                        <span className="text-xs text-destructive">{account.error}</span>
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
