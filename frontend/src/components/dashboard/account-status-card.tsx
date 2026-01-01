"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BarChart3, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { AccountsData, AccountLimitsResponse, AccountLimit } from "./types";
import { AccountLimitsModal } from "./account-limits-modal";

interface AccountStatusCardProps {
  accounts: AccountsData;
}

interface AccountUsage {
  anthropic: number | null;
  google: number | null;
}

function calculateUsage(account: AccountLimit, models: string[]): AccountUsage {
  const anthropicModels: number[] = [];
  const googleModels: number[] = [];

  for (const model of models) {
    const limit = account.limits[model];
    if (!limit || limit.remainingFraction === null) continue;

    if (model.includes("claude") || model.includes("sonnet") || model.includes("opus")) {
      anthropicModels.push(limit.remainingFraction);
    } else if (model.includes("gemini")) {
      googleModels.push(limit.remainingFraction);
    }
  }

  const anthropicAvg = anthropicModels.length > 0
    ? Math.round(anthropicModels.reduce((a, b) => a + b, 0) / anthropicModels.length * 100)
    : null;
  
  const googleAvg = googleModels.length > 0
    ? Math.round(googleModels.reduce((a, b) => a + b, 0) / googleModels.length * 100)
    : null;

  return { anthropic: anthropicAvg, google: googleAvg };
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
                onClick={fetchLimits}
                disabled={loading}
                className="gap-1.5"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
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
                        <div className="grid grid-cols-2 gap-3 pt-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Anthropic</span>
                            <span className={`text-sm font-semibold ${getUsageColor(usage.anthropic)}`}>
                              {usage.anthropic !== null ? `${usage.anthropic}%` : "-"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Google</span>
                            <span className={`text-sm font-semibold ${getUsageColor(usage.google)}`}>
                              {usage.google !== null ? `${usage.google}%` : "-"}
                            </span>
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
