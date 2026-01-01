# Cursor AI Bridge + ngrok Launcher (Windows)
# Creates a public HTTPS URL for Cursor IDE integration

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Cursor AI Bridge + ngrok" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if ngrok is installed
$ngrokPath = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrokPath) {
    Write-Host "❌ ngrok not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "To install ngrok:" -ForegroundColor Yellow
    Write-Host "1. Download from https://ngrok.com/download" -ForegroundColor Yellow
    Write-Host "2. Extract and add ngrok.exe to PATH" -ForegroundColor Yellow
    Write-Host "3. Sign up at ngrok.com and get your authtoken" -ForegroundColor Yellow
    Write-Host "4. Run: ngrok config add-authtoken YOUR_TOKEN" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host "✅ ngrok found" -ForegroundColor Green
Write-Host ""

# Start proxy server in background
Write-Host "🚀 Starting proxy server..." -ForegroundColor Yellow
$proxyProcess = Start-Process -FilePath "node" -ArgumentList "src/index.js" -PassThru -NoNewWindow

# Wait for server to start
Start-Sleep -Seconds 3

# Check if server is running
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -TimeoutSec 2 -ErrorAction Stop
    Write-Host "✅ Proxy server is running (port 8080)" -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to start proxy server!" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "🌐 Starting ngrok tunnel..." -ForegroundColor Yellow
Write-Host ""

# Start ngrok (in new window)
# --host-header=rewrite: Bypasses ngrok browser warning
# Forwards requests directly to the proxy
$ngrokProcess = Start-Process -FilePath "ngrok" -ArgumentList "http", "8080", "--host-header=rewrite" -PassThru

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ Everything is ready!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "📋 Next Steps:" -ForegroundColor Yellow
Write-Host "1. Copy the 'Forwarding' URL from ngrok window" -ForegroundColor White
Write-Host "   Example: https://abc123.ngrok-free.app" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Copy the API key from proxy server console output" -ForegroundColor White
Write-Host "   (Long string starting with ag_)" -ForegroundColor Gray
Write-Host ""
Write-Host "3. In Cursor IDE:" -ForegroundColor White
Write-Host "   - Settings > Models > Add Custom Model" -ForegroundColor Gray
Write-Host "   - Base URL: Paste your ngrok URL" -ForegroundColor Gray
Write-Host "   - API Key: Paste the API key from proxy" -ForegroundColor Gray
Write-Host "   - Model: claude-sonnet-4-5-thinking" -ForegroundColor Gray
Write-Host ""
Write-Host "4. To get ngrok URL automatically via API:" -ForegroundColor White
Write-Host "   curl http://localhost:4040/api/tunnels" -ForegroundColor Gray
Write-Host ""

# Try to get URL automatically from ngrok API
Start-Sleep -Seconds 2
try {
    $tunnels = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
    if ($tunnels.tunnels -and $tunnels.tunnels.Count -gt 0) {
        $publicUrl = $tunnels.tunnels[0].public_url
        Write-Host "🌍 Public URL: $publicUrl" -ForegroundColor Green
        Write-Host ""
        Write-Host "Use this URL as Base URL in Cursor!" -ForegroundColor Cyan
    }
} catch {
    Write-Host "⚠️  Could not access ngrok API. Get URL manually from ngrok window." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "To stop: Press Ctrl+C" -ForegroundColor Yellow
Write-Host ""

# Cleanup processes
$cleanup = {
    Write-Host "`n🛑 Stopping services..." -ForegroundColor Yellow
    Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $ngrokProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Host "✅ All processes stopped" -ForegroundColor Green
}

# Capture Ctrl+C
[Console]::TreatControlCAsInput = $false
Register-ObjectEvent -InputObject ([System.Console]) -EventName "CancelKeyPress" -Action $cleanup | Out-Null

# Wait
try {
    Wait-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue
} catch {
    # Process already stopped
}
