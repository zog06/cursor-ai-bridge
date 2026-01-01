# Cursor AI Bridge - Full Stack Starter (Windows)
# Starts backend, frontend, and ngrok together

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Cursor AI Bridge - Full Stack" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if backend dependencies are installed
if (-not (Test-Path "node_modules")) {
    Write-Host "⚠️  Backend dependencies not found!" -ForegroundColor Yellow
    Write-Host "Installing backend dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host "✅ Backend dependencies installed" -ForegroundColor Green
    Write-Host ""
}

# Check if frontend dependencies are installed
if (-not (Test-Path "frontend/node_modules")) {
    Write-Host "⚠️  Frontend dependencies not found!" -ForegroundColor Yellow
    Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
    Set-Location frontend
    npm install
    Set-Location ..
    Write-Host "✅ Frontend dependencies installed" -ForegroundColor Green
    Write-Host ""
}

Write-Host "🚀 Starting all services..." -ForegroundColor Yellow
Write-Host "  - Backend Server (port 8080)" -ForegroundColor Gray
Write-Host "  - Frontend Dashboard (port 3030)" -ForegroundColor Gray
Write-Host "  - ngrok HTTPS Tunnel" -ForegroundColor Gray
Write-Host ""

# Set START_NGROK=true environment variable for full mode
$env:START_NGROK = "true"

# Start everything with npm script
npm run start:full
