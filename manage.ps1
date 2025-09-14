# Storage Server Management Script
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("start", "stop", "restart", "logs", "status")]
    [string]$Action,
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("all", "infrastructure", "apps", "monitoring")]
    [string]$Module = "all"
)

$ErrorActionPreference = "Stop"

function Write-ColorOutput {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

function Start-Services {
    param([string]$Module)
    
    switch ($Module) {
        "all" {
            Write-ColorOutput "🚀 Starting all services..." "Green"
            docker-compose up -d
        }
        "infrastructure" {
            Write-ColorOutput "🔧 Starting infrastructure services..." "Blue"
            docker-compose up -d traefik tsdproxy
        }
        "apps" {
            Write-ColorOutput "📱 Starting application services..." "Cyan"
            docker-compose up -d filebrowser stirling-pdf whoami landing-page
        }
        "monitoring" {
            Write-ColorOutput "📊 Starting monitoring services..." "Yellow"
            docker-compose up -d prometheus grafana loki promtail jaeger docker-exporter
        }
    }
}

function Stop-Services {
    param([string]$Module)
    
    switch ($Module) {
        "all" {
            Write-ColorOutput "🛑 Stopping all services..." "Red"
            docker-compose down
        }
        "infrastructure" {
            Write-ColorOutput "🔧 Stopping infrastructure services..." "Blue"
            docker-compose stop traefik tsdproxy
        }
        "apps" {
            Write-ColorOutput "📱 Stopping application services..." "Cyan"
            docker-compose stop filebrowser stirling-pdf whoami landing-page
        }
        "monitoring" {
            Write-ColorOutput "📊 Stopping monitoring services..." "Yellow"
            docker-compose stop prometheus grafana loki promtail jaeger docker-exporter
        }
    }
}

function Restart-Services {
    param([string]$Module)
    
    Write-ColorOutput "🔄 Restarting $Module services..." "Magenta"
    Stop-Services $Module
    Start-Sleep 3
    Start-Services $Module
}

function Show-Logs {
    param([string]$Module)
    
    switch ($Module) {
        "all" {
            Write-ColorOutput "📋 Showing logs for all services..." "Green"
            docker-compose logs -f
        }
        "infrastructure" {
            Write-ColorOutput "📋 Showing logs for infrastructure services..." "Blue"
            docker-compose logs -f traefik tsdproxy
        }
        "apps" {
            Write-ColorOutput "📋 Showing logs for application services..." "Cyan"
            docker-compose logs -f filebrowser stirling-pdf whoami landing-page
        }
        "monitoring" {
            Write-ColorOutput "📋 Showing logs for monitoring services..." "Yellow"
            docker-compose logs -f prometheus grafana loki promtail jaeger docker-exporter
        }
    }
}

function Show-Status {
    Write-ColorOutput "📊 Storage Server Status" "Green"
    Write-ColorOutput "=======================" "Green"
    
    Write-ColorOutput "`n🔧 Infrastructure Services:" "Blue"
    docker-compose ps traefik tsdproxy
    
    Write-ColorOutput "`n📱 Application Services:" "Cyan"
    docker-compose ps filebrowser stirling-pdf whoami landing-page
    
    Write-ColorOutput "`n📊 Monitoring Services:" "Yellow"
    docker-compose ps prometheus grafana loki promtail jaeger docker-exporter
    
    Write-ColorOutput "`n🌐 Access URLs:" "Green"
    Write-Host "  • Landing Page: https://aden-traefik.taila3d69a.ts.net/" -ForegroundColor White
    Write-Host "  • File Browser: https://aden-traefik.taila3d69a.ts.net/filebrowser" -ForegroundColor White
    Write-Host "  • Stirling PDF: https://stirling-pdf.taila3d69a.ts.net" -ForegroundColor White
    Write-Host "  • Admin Dashboard: https://aden-traefik.taila3d69a.ts.net:8082" -ForegroundColor Gray
    Write-Host "  • Grafana: https://aden-traefik.taila3d69a.ts.net:3000" -ForegroundColor Gray
}

# Main execution
try {
    switch ($Action) {
        "start" { Start-Services $Module }
        "stop" { Stop-Services $Module }
        "restart" { Restart-Services $Module }
        "logs" { Show-Logs $Module }
        "status" { Show-Status }
    }
    
    Write-ColorOutput "`n✅ Operation completed successfully!" "Green"
} catch {
    Write-ColorOutput "`n❌ Error: $($_.Exception.Message)" "Red"
    exit 1
}
