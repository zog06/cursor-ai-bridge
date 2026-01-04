"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretField } from "./secret-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

interface OpenAISettings {
  apiKey: string | null;
  baseUrl: string | null;
  apiKeyEnabled: boolean;
  baseUrlEnabled: boolean;
}

interface ApiConfigCardProps {
  apiKey: string;
  ngrokUrl: string | null;
}

export function ApiConfigCard({ apiKey, ngrokUrl }: ApiConfigCardProps) {
  const [openAISettings, setOpenAISettings] = useState<OpenAISettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [currentApiKey, setCurrentApiKey] = useState(apiKey);

  const fetchCursorSettings = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/cursor/settings");
      const data = await response.json();
      setOpenAISettings(data.openai || null);
    } catch (error) {
      console.error("Failed to fetch Cursor settings:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCursorSettings();
  }, []);

  const handleToggleOpenAI = async (enabled: boolean) => {
    if (enabled) {
      // Show warning that Cursor must be closed
      const confirmed = window.confirm(
        "⚠️ IMPORTANT: Cursor must be closed!\n\n" +
        "Cursor must be closed before enabling configuration. " +
        "Use the Override button to update settings while Cursor is closed.\n\n" +
        "Do you want to continue?"
      );
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      // Toggle both API Key and Base URL together
      const [apiKeyResponse, baseUrlResponse] = await Promise.all([
        fetch("/api/cursor/openai/toggle-api-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }),
        fetch("/api/cursor/openai/toggle-base-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }),
      ]);

      const apiKeyResult = await apiKeyResponse.json();
      const baseUrlResult = await baseUrlResponse.json();

      if (apiKeyResult.status === "success" && baseUrlResult.status === "success") {
        await fetchCursorSettings();
        if (enabled) {
          alert("✅ OpenAI settings enabled. Make sure Cursor is closed before using.");
        } else {
          alert("✅ OpenAI settings disabled.");
        }
      } else {
        alert("An error occurred. Please try again.");
      }
    } catch (error) {
      console.error("Failed to toggle OpenAI settings:", error);
      alert("An error occurred while updating settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleOverride = async () => {
    if (!ngrokUrl) {
      alert("ngrok URL not found. Please start ngrok first.");
      return;
    }

    const confirmed = window.confirm(
      "⚠️ Override Configuration\n\n" +
      "This will update Cursor settings even if Cursor is currently running. " +
      "Make sure Cursor is closed for changes to take effect.\n\n" +
      "Do you want to continue?"
    );
    
    if (!confirmed) return;

    setSaving(true);
    try {
      // Update both API Key and Base URL
      const [apiKeyResponse, baseUrlResponse] = await Promise.all([
        fetch("/api/cursor/openai/api-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiKey: currentApiKey, enabled: true }),
        }),
        fetch("/api/cursor/openai/base-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseUrl: ngrokUrl, enabled: true }),
        }),
      ]);

      const apiKeyResult = await apiKeyResponse.json();
      const baseUrlResult = await baseUrlResponse.json();

      if (apiKeyResult.status === "success" && baseUrlResult.status === "success") {
        await fetchCursorSettings();
        alert("✅ Configuration overridden successfully. Make sure Cursor is closed before starting it.");
      } else {
        alert("An error occurred. Please try again.");
      }
    } catch (error) {
      console.error("Failed to override configuration:", error);
      alert("An error occurred while overriding configuration.");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateApiKey = async () => {
    if (!ngrokUrl) {
      alert("ngrok URL not found. Please start ngrok first.");
      return;
    }
    
    setSaving(true);
    try {
      const response = await fetch("/api/cursor/openai/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: currentApiKey, enabled: true }),
      });
      const result = await response.json();
      if (result.status === "success") {
        await fetchCursorSettings();
        alert("OpenAI API Key updated!");
      } else {
        alert(result.message || "Update failed");
      }
    } catch (error) {
      console.error("Failed to update API Key:", error);
      alert("An error occurred while updating API Key.");
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateApiKey = async () => {
    const confirmed = window.confirm(
      "⚠️ Regenerate API Key\n\n" +
      "This will generate a new API key and invalidate the old one.\n" +
      "You'll need to update Cursor IDE settings with the new key.\n\n" +
      "Do you want to continue?"
    );
    
    if (!confirmed) return;

    setRegenerating(true);
    try {
      const response = await fetch("/api/regenerate-api-key", {
        method: "POST",
      });
      const result = await response.json();
      if (result.status === "success") {
        setCurrentApiKey(result.apiKey);
        alert("✅ API Key regenerated!\n\nNew key: " + result.apiKey.substring(0, 20) + "...\n\nPlease update your Cursor IDE settings.");
      } else {
        alert("Failed to regenerate API key: " + result.message);
      }
    } catch (error) {
      console.error("Failed to regenerate API key:", error);
      alert("An error occurred while regenerating API key.");
    } finally {
      setRegenerating(false);
    }
  };

  const handleUpdateBaseUrl = async () => {
    if (!ngrokUrl) {
      alert("ngrok URL not found. Please start ngrok first.");
      return;
    }
    
    setSaving(true);
    try {
      const response = await fetch("/api/cursor/openai/base-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: ngrokUrl, enabled: true }),
      });
      const result = await response.json();
      if (result.status === "success") {
        await fetchCursorSettings();
        alert("OpenAI Base URL updated!");
      } else {
        alert(result.message || "Update failed");
      }
    } catch (error) {
      console.error("Failed to update Base URL:", error);
      alert("An error occurred while updating Base URL.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border/40">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">API Configuration</CardTitle>
            <CardDescription>Your proxy API key</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchCursorSettings}
            disabled={loading || saving}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Proxy API Key - More prominent */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Proxy API Key</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerateApiKey}
              disabled={regenerating}
              className="h-7 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${regenerating ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
          </div>
          <SecretField value={currentApiKey} />
          <p className="text-sm text-muted-foreground">
            Use this key to authenticate requests to the proxy server
          </p>
        </div>
        
        {ngrokUrl && (
          <div className="pt-3 border-t border-border/40 space-y-3">
            <h3 className="text-sm font-semibold">Public Endpoint</h3>
            <SecretField value={ngrokUrl} size="sm" />
            <p className="text-sm text-muted-foreground">
              Use this URL as Base URL in Cursor IDE
            </p>
          </div>
        )}

        {/* Cursor OpenAI Settings */}
        {openAISettings && (
          <div className="pt-4 border-t border-border/40 space-y-4">
            {/* Warning Alert */}
            {(openAISettings.apiKeyEnabled || openAISettings.baseUrlEnabled) && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20">
                <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400 mb-1">
                    ⚠️ Close Cursor
                  </p>
                  <p className="text-xs text-yellow-600/80 dark:text-yellow-400/80">
                    Cursor must be closed before making configuration changes. 
                    Use the Override button to update settings while Cursor is closed.
                  </p>
                </div>
              </div>
            )}

            {/* Unified OpenAI Toggle */}
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <p className="text-sm font-medium mb-1">Cursor OpenAI Configuration</p>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    API Key: {openAISettings.apiKey 
                      ? `${openAISettings.apiKey.substring(0, 5)}${'*'.repeat(Math.max(0, openAISettings.apiKey.length - 5))}`
                      : "Not configured"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Base URL: {openAISettings.baseUrl 
                      ? `${openAISettings.baseUrl.substring(0, 11)}${'*'.repeat(Math.max(0, openAISettings.baseUrl.length - 11))}`
                      : "Not configured"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(openAISettings.apiKeyEnabled && openAISettings.baseUrlEnabled) ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-muted-foreground" />
                )}
                <Switch
                  checked={openAISettings.apiKeyEnabled && openAISettings.baseUrlEnabled}
                  onCheckedChange={handleToggleOpenAI}
                  disabled={saving || !openAISettings.apiKey || !openAISettings.baseUrl}
                />
                {ngrokUrl && openAISettings.apiKey && openAISettings.baseUrl && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOverride}
                    disabled={saving}
                    className="text-xs"
                  >
                    Override
                  </Button>
                )}
              </div>
            </div>

            {/* Setup Buttons */}
            {(!openAISettings.apiKey || !openAISettings.baseUrl) && ngrokUrl && (
              <div className="flex gap-2">
                {!openAISettings.apiKey && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUpdateApiKey}
                    disabled={saving}
                    className="flex-1"
                  >
                    Set API Key
                  </Button>
                )}
                {(!openAISettings.baseUrl || openAISettings.baseUrl !== ngrokUrl) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUpdateBaseUrl}
                    disabled={saving}
                    className="flex-1"
                  >
                    {openAISettings.baseUrl ? "Update" : "Set"} Base URL
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
