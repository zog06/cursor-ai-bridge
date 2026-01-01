"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, Copy, CheckCircle2 } from "lucide-react";

interface SecretFieldProps {
  value: string;
  className?: string;
  size?: "sm" | "default";
}

export function SecretField({ value, className = "", size = "default" }: SecretFieldProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const maskText = () => "•".repeat(40);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const textSize = size === "sm" ? "text-xs" : "text-sm";

  return (
    <div className="flex items-center gap-2">
      <code className={`flex-1 px-3 py-2 bg-muted/50 rounded-md ${textSize} font-mono border border-border/40 select-none truncate ${className}`}>
        {isVisible ? value : maskText()}
      </code>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsVisible(!isVisible)}
      >
        {isVisible ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={handleCopy}
      >
        {isCopied ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
