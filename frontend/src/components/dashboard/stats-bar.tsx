import { Server, Clock, Users, Globe, LucideIcon } from "lucide-react";
import { ServerData, NgrokData } from "./types";

interface StatItemProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
}

function StatItem({ icon: Icon, label, value }: StatItemProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border/40 bg-background/50">
      <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

interface StatsBarProps {
  server: ServerData;
  ngrok: NgrokData;
}

export function StatsBar({ server, ngrok }: StatsBarProps) {
  const isNgrokConnected = ngrok.status === "connected";

  return (
    <div className="grid grid-cols-4 gap-4">
      <StatItem 
        icon={Server} 
        label="Server" 
        value={server.port} 
      />
      
      <StatItem 
        icon={Clock} 
        label="Uptime" 
        value={server.uptime} 
      />
      
      {server.accounts && (
        <StatItem 
          icon={Users} 
          label="Accounts" 
          value={`${server.accounts.available}/${server.accounts.total}`} 
        />
      )}
      
      <StatItem 
        icon={Globe} 
        label="Public URL" 
        value={isNgrokConnected ? "Active" : "Inactive"} 
      />
    </div>
  );
}
