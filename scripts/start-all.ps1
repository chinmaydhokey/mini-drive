# ==============================================================
# MiniDrive - Start All Services
# ==============================================================
# Launches: 2x API Servers + Metadata Service + 3x Storage Nodes
# Ports:    3000, 3001, 4000, 5001, 5002, 5003
#
# Prerequisites:
#   - MongoDB running on localhost:27017
#   - Redis running on localhost:6379 (optional - app works without)
#   - npm install completed in each service directory
#
# Usage:
#   .\scripts\start-all.ps1
#   .\scripts\start-all.ps1 -StopAll   # Kill all running services
# ==============================================================

param([switch]$StopAll)

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = "d:\Distributed File System Project" }

if ($StopAll) {
    Write-Host "`n[STOPPING] Stopping all MiniDrive services..." -ForegroundColor Red
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "   Done.`n"
    exit
}

Write-Host "`n[STARTING] Starting MiniDrive Services`n" -ForegroundColor Cyan

# -- Storage Nodes ---------------------------------------------
$storageNodePath = Join-Path $Root "services\storage-node"
for ($i = 1; $i -le 3; $i++) {
    $port = 5000 + $i
    $nodeId = "node-$i"
    $cmd = "Set-Location '$storageNodePath'; `$env:PORT=$port; `$env:NODE_ID='$nodeId'; node src/app.js"
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $cmd
    Write-Host "   [Storage Node] ($nodeId) -> port $port" -ForegroundColor Green
}

# -- Metadata Service ------------------------------------------
$metaPath = Join-Path $Root "services\metadata-service"
$cmd = "Set-Location '$metaPath'; node src/app.js"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $cmd
Write-Host "   [Metadata Service] -> port 4000" -ForegroundColor Green

# -- API Server ------------------------------------------------
$apiPath = Join-Path $Root "services\api-server"
$cmd = "Set-Location '$apiPath'; `$env:PORT=3000; node src/app.js"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $cmd
Write-Host "   [API Server] -> port 3000" -ForegroundColor Green

# -- Frontend --------------------------------------------------
$frontendPath = Join-Path $Root "services\frontend"
$cmd = "Set-Location '$frontendPath'; npm run dev"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $cmd
Write-Host "   [Frontend] -> port 5173" -ForegroundColor Green

Write-Host "`n[SUCCESS] All services started. Ports:" -ForegroundColor Cyan
Write-Host "   API:       3000"
Write-Host "   Metadata:  4000"
Write-Host "   Storage:   5001, 5002, 5003"
Write-Host "   Frontend:  http://localhost:5173"
Write-Host "   Admin UI:  http://localhost:5173/admin`n"