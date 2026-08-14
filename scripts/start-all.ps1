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

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
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
    $job = Start-Job -ScriptBlock {
        param($path, $port, $nodeId)
        Set-Location $path
        $env:PORT = $port
        $env:NODE_ID = $nodeId
        node src/app.js
    } -ArgumentList $storageNodePath, $port, $nodeId
    Write-Host "   [Storage Node] ($nodeId) -> port $port" -ForegroundColor Green
}

# -- Metadata Service ------------------------------------------
$metaPath = Join-Path $Root "services\metadata-service"
Start-Job -ScriptBlock {
    param($path)
    Set-Location $path
    node src/app.js
} -ArgumentList $metaPath | Out-Null
Write-Host "   [Metadata Service] -> port 4000" -ForegroundColor Green

# -- API Servers (2 instances for load balancing) ---------------
$apiPath = Join-Path $Root "services\api-server"
foreach ($port in @(3000, 3001)) {
    Start-Job -ScriptBlock {
        param($path, $port)
        Set-Location $path
        $env:PORT = $port
        node src/app.js
    } -ArgumentList $apiPath, $port | Out-Null
    Write-Host "   [API Server] -> port $port" -ForegroundColor Green
}

Write-Host "`n[SUCCESS] All services starting. Ports:" -ForegroundColor Cyan
Write-Host "   API:       3000, 3001"
Write-Host "   Metadata:  4000"
Write-Host "   Storage:   5001, 5002, 5003"
Write-Host "   Frontend:  Run 'npm run dev' in services/frontend/"
Write-Host "   Nginx:     Run 'nginx -c nginx/nginx.conf' (optional)`n"