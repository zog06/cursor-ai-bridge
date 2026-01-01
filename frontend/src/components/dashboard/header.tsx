import { Badge } from "@/components/ui/badge";
import { Zap, CheckCircle2, AlertCircle } from "lucide-react";

interface HeaderProps {
  isOnline: boolean;
}

export function Header({ isOnline }: HeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
          <Zap className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Antigravity</h1>
          <p className="text-sm text-muted-foreground">Proxy Dashboard</p>
        </div>
      </div>
      
      <Badge variant={isOnline ? "default" : "destructive"} className="gap-1.5">
        {isOnline ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : (
          <AlertCircle className="h-3 w-3" />
        )}
        {isOnline ? "Online" : "Offline"}
      </Badge>
    </div>
  );
}
