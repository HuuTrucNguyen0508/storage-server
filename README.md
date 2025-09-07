# Isolated File Storage System

A production-ready file storage system with React frontend, Next.js API backend, and SQLite database, all running in isolated Docker containers with persistent storage on SSD.

## 🚀 Features

- **Unlimited File Sizes**: No file size restrictions
- **All File Types**: Supports APK, JSON, MD, images, documents, and more
- **Persistent Storage**: Data stored on F: drive with Docker volumes
- **SQLite Database**: Robust metadata storage with lowdb
- **Docker Isolation**: Each component runs in its own container
- **Nginx Reverse Proxy**: Handles CORS, rate limiting, and large file transfers
- **Modern UI**: React with Tailwind CSS
- **Real-time Updates**: Frontend automatically refreshes after operations

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Nginx         │    │   Backend       │
│   (React)       │◄──►│   (Reverse      │◄──►│   (Next.js API) │
│   Port: 3000    │    │   Proxy)        │    │   Port: 3001    │
│                 │    │   Port: 8080    │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                                       ▼
                                               ┌─────────────────┐
                                               │   Database      │
                                               │   (SQLite)      │
                                               │   F:/web_uploads│
                                               └─────────────────┘
```

## 🛠️ Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS
- **Backend**: Next.js 14, Node.js 18
- **Database**: SQLite with lowdb
- **Proxy**: Nginx
- **Containerization**: Docker & Docker Compose
- **Package Manager**: pnpm

## 📦 Quick Start

### Prerequisites

- Docker and Docker Compose
- Windows with F: drive available
- PowerShell

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd storage-server
   ```

2. **Start the system**
   ```bash
   docker-compose up -d
   ```

3. **Access the application**
   - Frontend: http://localhost:8080
   - API: http://localhost:8080/api

### First Run

The system will automatically:
- Create necessary directories on F: drive
- Initialize the SQLite database
- Set up Docker volumes for persistent storage
- Configure Nginx reverse proxy

## 📁 File Operations

### Upload Files
- Drag and drop or click to select files
- No file size limits
- Supports all file types
- Files are stored with unique names preserving original names

### Download Files
- Click the download button next to any file
- Files download with their original names

### Delete Files
- Click the delete button to remove files
- Files are removed from both filesystem and database

## 🔧 Configuration

### Storage Location
Files are stored in: `F:\web_uploads`
- `F:\web_uploads\uploads\` - Actual files
- `F:\web_uploads\database\` - SQLite database

### Environment Variables
- `NODE_ENV=production` - Set for production mode
- All services run in production mode for optimal performance

### Nginx Configuration
- No file size limits
- Optimized for large file transfers
- CORS enabled for all origins
- Rate limiting configured

## 🐳 Docker Services

### Frontend Service
- **Image**: Custom React build
- **Port**: 3000 (internal)
- **Dependencies**: Backend

### Backend Service
- **Image**: Custom Next.js build
- **Port**: 3001 (internal)
- **Dependencies**: Database
- **Volumes**: F:/web_uploads

### Nginx Service
- **Image**: nginx:alpine
- **Port**: 8080 (external)
- **Dependencies**: Frontend, Backend

### Database Service
- **Image**: alpine:latest
- **Purpose**: Volume management
- **Volumes**: F:/web_uploads/database

## 🔍 API Endpoints

### Upload File
```
POST /api/upload
Content-Type: multipart/form-data
Body: file (binary)
```

### List Files
```
GET /api/files
Response: Array of file objects
```

### Download File
```
GET /api/files/{filename}
Response: File binary
```

### Delete File
```
DELETE /api/files/{filename}
Response: Success message
```

## 🚨 Troubleshooting

### Common Issues

1. **Port 8080 already in use**
   ```bash
   # Change port in docker-compose.yml
   ports:
     - "8081:80"  # Use port 8081 instead
   ```

2. **F: drive not accessible**
   - Ensure F: drive exists and is accessible
   - Check Docker Desktop file sharing settings

3. **Files not persisting**
   - Verify Docker volumes are properly mounted
   - Check F:\web_uploads directory permissions

4. **Upload fails**
   - Check Nginx logs: `docker logs storage-server-nginx-1`
   - Check backend logs: `docker logs storage-server-backend-1`

### Logs

```bash
# View all logs
docker-compose logs

# View specific service logs
docker-compose logs frontend
docker-compose logs backend
docker-compose logs nginx
```

## 🔄 Maintenance

### Restart Services
```bash
docker-compose restart
```

### Update System
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Clean Up
```bash
# Remove containers and volumes
docker-compose down -v

# Clean Docker system
docker system prune -f
```

## 📊 Performance

- **File Size**: Unlimited (tested with 50MB+ files)
- **Concurrent Users**: Handles multiple simultaneous uploads
- **Storage**: Persistent across container restarts
- **Memory**: Optimized for large file handling

## 🔒 Security

- CORS enabled for development
- Rate limiting on API endpoints
- File type validation
- Secure file naming with UUIDs

## 📝 License

This project is licensed under the MIT License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For issues and questions:
1. Check the troubleshooting section
2. Review Docker logs
3. Create an issue in the repository