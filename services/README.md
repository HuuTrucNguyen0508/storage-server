# Storage Server Services

This directory contains the individual service components of the storage server, each with their own Docker Compose configuration.

## Services

### Backend (`/backend`)
- **Purpose**: API server for file management
- **Port**: 3001 (internal)
- **Dependencies**: Database
- **Volumes**: F:\web_uploads

### Frontend (`/frontend`)
- **Purpose**: Web UI for the storage server
- **Port**: 3000 (internal)
- **Dependencies**: Backend

### Nginx (`/nginx`)
- **Purpose**: Reverse proxy and static file serving
- **Port**: 8083 (external)
- **Dependencies**: Frontend, Backend
- **Volumes**: F:\web_uploads

## Usage

### Start Individual Service
```bash
cd services/backend
docker-compose up -d
```

### Start All Services
```bash
# From project root
./start-all.ps1
```

### Stop All Services
```bash
# From project root
./stop-all.ps1
```

## Network

All services use the external network `file-storage-network` for communication.
