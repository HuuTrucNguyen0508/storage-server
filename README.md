# Storage Server

A modular Docker Compose setup for a personal storage server with monitoring, applications, and Tailscale integration.

## 🏗️ Architecture

This project is organized into modular Docker Compose files for better maintainability:

```
├── docker-compose.yml           # Main compose with include directives
├── apps/
│   └── docker-compose.yml       # Application services (Filebrowser, Stirling PDF, etc.)
├── monitoring/
│   └── docker-compose.yml       # Monitoring services (Grafana, Prometheus, etc.)
└── config/
    ├── tsdproxy.yaml            # tsdproxy configuration
    └── config.json              # Tailscale configuration
```

## 🚀 Quick Start

### Option 1: Deploy Everything (Recommended)
```bash
# Deploy all services at once using include
docker-compose up -d
```

### Option 2: Deploy Modularly
```bash
# Start specific services
docker-compose up -d traefik tsdproxy                    # Infrastructure only
docker-compose up -d filebrowser stirling-pdf whoami     # Apps only
docker-compose up -d prometheus grafana loki            # Monitoring only
```

## 🌐 Access Your Services

### Public Services (Shareable)
- **Landing Page**: https://aden-traefik.taila3d69a.ts.net/
- **File Browser**: https://aden-traefik.taila3d69a.ts.net/filebrowser
- **Stirling PDF**: https://stirling-pdf.taila3d69a.ts.net
- **System Test**: https://aden-traefik.taila3d69a.ts.net/whoami

### Admin Services (Direct Access)
- **Traefik Dashboard**: https://aden-traefik.taila3d69a.ts.net:8082
- **Grafana**: https://aden-traefik.taila3d69a.ts.net:3000
- **Prometheus**: https://aden-traefik.taila3d69a.ts.net:9090

## 📁 Services Overview

### Infrastructure (`docker-compose.yml`)
- **Traefik**: Reverse proxy and load balancer
- **tsdproxy**: Tailscale proxy for remote access

### Applications (`apps/docker-compose.yml`)
- **Landing Page**: Centralized service hub
- **Filebrowser**: Web-based file management
- **Stirling PDF**: PDF processing tools
- **Whoami**: System test service

### Monitoring (`monitoring/docker-compose.yml`)
- **Grafana**: Monitoring dashboards
- **Prometheus**: Metrics collection
- **Loki**: Log aggregation
- **Jaeger**: Distributed tracing
- **cAdvisor**: Container metrics

## 🔧 Management Commands

### Start Services
```bash
# All services
docker-compose up -d

# Just infrastructure
docker-compose up -d traefik tsdproxy

# Just applications
docker-compose up -d filebrowser stirling-pdf whoami landing-page

# Just monitoring
docker-compose up -d prometheus grafana loki promtail jaeger docker-exporter
```

### Stop Services
```bash
# All services
docker-compose down

# Specific services
docker-compose stop filebrowser stirling-pdf
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f traefik

# Service groups
docker-compose logs -f filebrowser stirling-pdf whoami landing-page
```

## 🔐 Authentication

### Tailscale Setup
1. Ensure `TS_SECRET` environment variable is set
2. Access authentication URLs when prompted in tsdproxy logs
3. Complete authentication for each new service

### Service Access
- **Public services**: Accessible via Tailscale network
- **Admin services**: Direct port access only

## 📊 Monitoring

The monitoring stack provides:
- **System metrics**: CPU, memory, disk usage
- **Container metrics**: Resource usage per container
- **Application logs**: Centralized log collection
- **Network tracing**: Request flow visualization

Access Grafana at `:3000` with admin/admin credentials.

## 🛠️ Configuration

### Environment Variables
- `TS_SECRET`: Tailscale auth key for tsdproxy

### File Paths
- Filebrowser data: `F:\content`
- Stirling PDF configs: `./StirlingPDF/`
- Monitoring configs: `./monitoring/`

## 🔄 Updates

### Update All Services
```bash
docker-compose pull
docker-compose up -d
```

### Update Specific Services
```bash
docker-compose pull filebrowser stirling-pdf
docker-compose up -d filebrowser stirling-pdf
```

## 📝 Notes

- All services use the same Docker network (`file-storage-network`)
- Traefik handles routing and SSL termination
- tsdproxy provides Tailscale integration
- Monitoring services are optional and can be started separately
- Landing page provides centralized access to public services