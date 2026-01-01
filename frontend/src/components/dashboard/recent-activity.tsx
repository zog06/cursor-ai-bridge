import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Zap } from "lucide-react";
import { RequestData } from "./types";

interface RecentActivityProps {
  requests: RequestData[];
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

export function RecentActivity({ requests }: RecentActivityProps) {
  return (
    <Card className="border-border/40">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent Activity</CardTitle>
            <CardDescription>Last {requests.length} requests</CardDescription>
          </div>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No requests yet
          </p>
        ) : (
          <div className="space-y-2">
            {requests.map((request) => (
              <div
                key={request.id}
                className="flex items-center justify-between p-3 rounded-md border border-border/40 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Badge variant="outline" className="shrink-0">
                    {request.method}
                  </Badge>
                  <code className="text-xs truncate">{request.path}</code>
                  {request.model && (
                    <span className="text-xs text-muted-foreground truncate">
                      {request.model}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {/* Token Usage */}
                  {request.usage && (
                    <div className="flex items-center gap-2 text-xs">
                      <div className="flex items-center gap-1 text-muted-foreground" title="Input tokens">
                        <span className="text-blue-400">↓</span>
                        <span>{formatTokens(request.usage.input_tokens)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground" title="Output tokens">
                        <span className="text-green-400">↑</span>
                        <span>{formatTokens(request.usage.output_tokens)}</span>
                      </div>
                      {request.usage.cache_read_input_tokens > 0 && (
                        <div className="flex items-center gap-1 text-muted-foreground" title="Cache read tokens">
                          <Zap className="h-3 w-3 text-yellow-400" />
                          <span>{formatTokens(request.usage.cache_read_input_tokens)}</span>
                        </div>
                      )}
                      {request.tools && request.tools.count > 0 && (
                        <div className="flex items-center gap-1 text-muted-foreground" title={`${request.tools.count} tools (~${formatTokens(request.tools.tokens)} tokens)`}>
                          <span className="text-purple-400">🔧</span>
                          <span>{request.tools.count}</span>
                          <span className="text-xs opacity-70">(~{formatTokens(request.tools.tokens)})</span>
                        </div>
                      )}
                    </div>
                  )}
                  {request.duration && (
                    <span className="text-xs text-muted-foreground">
                      {request.duration}ms
                    </span>
                  )}
                  <Badge
                    variant={
                      request.status === "success"
                        ? "default"
                        : request.status === "error"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {request.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(request.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
