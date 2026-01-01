"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle } from "lucide-react";
import {
  Header,
  StatsBar,
  ApiConfigCard,
  AccountStatusCard,
  RecentActivity,
  DashboardData,
} from "@/components/dashboard";

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const response = await fetch("/api/dashboard");
      const json = await response.json();
      setData(json);
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Activity className="h-4 w-4 animate-pulse" />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span>Connection failed</span>
        </div>
      </div>
    );
  }

  const isServerOnline = data.server.status === "ok";

  return (
    <div className="min-h-screen bg-background">
      {/* Header with Stats */}
      <div className="border-b border-border/40 bg-card/50">
        <div className="container mx-auto px-6 py-6">
          <div className="mb-6">
            <Header isOnline={isServerOnline} />
          </div>
          <StatsBar server={data.server} ngrok={data.ngrok} />
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          <ApiConfigCard 
            apiKey={data.apiKey} 
            ngrokUrl={data.ngrok.url} 
          />
          
          {data.server.accounts && (
            <AccountStatusCard accounts={data.server.accounts} />
          )}
        </div>

        <div className="mt-6">
          <RecentActivity requests={data.requests} />
        </div>
      </div>
    </div>
  );
}
