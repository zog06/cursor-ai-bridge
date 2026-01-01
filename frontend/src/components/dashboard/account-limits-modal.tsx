"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { AccountLimitsResponse, AccountLimit } from "./types";

interface AccountLimitsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountLimitsModal({ open, onOpenChange }: AccountLimitsModalProps) {
  const [data, setData] = useState<AccountLimitsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLimits = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/account-limits");
      if (!response.ok) {
        throw new Error("Failed to fetch account limits");
      }
      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchLimits();
    }
  }, [open]);

  const getStatusBadge = (account: AccountLimit) => {
    if (account.status === "ok") {
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle2 className="h-3 w-3" />
          OK
        </Badge>
      );
    } else if (account.status === "invalid") {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Invalid
        </Badge>
      );
    } else {
      return (
        <Badge variant="secondary" className="gap-1">
          {account.status}
        </Badge>
      );
    }
  };

  const getQuotaColor = (fraction: number | null) => {
    if (fraction === null) return "text-muted-foreground";
    if (fraction > 0.5) return "text-green-500";
    if (fraction > 0.2) return "text-yellow-500";
    return "text-red-500";
  };

  const formatResetTime = (resetTime: string | null) => {
    if (!resetTime) return "-";
    const date = new Date(resetTime);
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    
    if (diff <= 0) return "Now";
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>Account Usage Limits</DialogTitle>
              <DialogDescription>
                View quota and rate limits for all accounts
              </DialogDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchLimits}
              disabled={loading}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {loading && !data && (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12 text-destructive gap-2">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          )}

          {data && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex items-center gap-4 text-sm text-muted-foreground border-b border-border/40 pb-3">
                <span>Last updated: {data.timestamp}</span>
                <span>•</span>
                <span>{data.totalAccounts} accounts</span>
                <span>•</span>
                <span>{data.models.length} models</span>
              </div>

              {/* Accounts List */}
              <div className="space-y-4">
                {data.accounts.map((account, idx) => (
                  <div
                    key={idx}
                    className="border border-border/40 rounded-lg p-4 space-y-3"
                  >
                    {/* Account Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm">{account.email}</span>
                        {getStatusBadge(account)}
                      </div>
                      {account.error && (
                        <span className="text-xs text-destructive">{account.error}</span>
                      )}
                    </div>

                    {/* Model Limits */}
                    {account.status === "ok" && (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {data.models.map((model) => {
                          const limit = account.limits[model];
                          if (!limit) return null;

                          return (
                            <div
                              key={model}
                              className="flex items-center justify-between p-2 rounded-md bg-muted/30 border border-border/20"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-mono truncate" title={model}>
                                  {model.replace("claude-", "").replace("-20241022", "")}
                                </p>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className={`text-sm font-semibold ${getQuotaColor(limit.remainingFraction)}`}>
                                    {limit.remaining}
                                  </span>
                                  {limit.resetTime && (
                                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {formatResetTime(limit.resetTime)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
