const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

class DatabaseService {
  constructor() {
    // Use the mounted volume path for database
    this.dbPath = path.join('/app/database/files.json');
    this.uploadsDir = path.join('/app/uploads');
    
    // Ensure directories exist
    this.ensureDirectories();
    
    // Initialize database
    this.init();
  }

  // Singleton pattern to prevent multiple instances
  static getInstance() {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  ensureDirectories() {
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  init() {
    try {
      // Only initialize if not already initialized
      if (this.db) {
        return;
      }

      // Create adapter and database
      const adapter = new FileSync(this.dbPath);
      this.db = low(adapter);
      
      // Check if the database has the correct structure
      if (!this.db.has('files').value()) {
        // Check if the file contains an array (old format)
        const rawData = this.db.value();
        if (Array.isArray(rawData)) {
          // Convert old array format to new object format
          this.db.setState({ files: rawData }).write();
        } else {
          // Initialize with empty structure
          this.db.defaults({ files: [] }).write();
        }
      }
    } catch (error) {
      console.error('Error initializing database:', error);
      throw error;
    }
  }

  // Save file information to database
  saveFile(fileInfo) {
    try {
      const fileData = {
        id: Date.now() + Math.random(), // Simple unique ID
        filename: fileInfo.filename,
        originalName: fileInfo.originalName,
        size: fileInfo.size,
        mimeType: fileInfo.mimeType,
        filePath: fileInfo.filePath,
        uploadedAt: fileInfo.uploadedAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      this.db.get('files').push(fileData).write();
      return true;
    } catch (error) {
      console.error('Error saving file to database:', error);
      return false;
    }
  }

  // Get all files
  getAllFiles() {
    try {
      const files = this.db.get('files').sortBy('uploadedAt').reverse().value();
      return files;
    } catch (error) {
      console.error('Error retrieving files from database:', error);
      return [];
    }
  }

  // Get a specific file by filename
  getFile(filename) {
    try {
      const file = this.db.get('files').find({ filename }).value();
      return file;
    } catch (error) {
      console.error('Error retrieving file from database:', error);
      return null;
    }
  }

  // Delete a file from database
  deleteFile(filename) {
    try {
      const result = this.db.get('files').remove({ filename }).write();
      return result.length > 0;
    } catch (error) {
      console.error('Error deleting file from database:', error);
      return false;
    }
  }

  // Get file statistics
  getStats() {
    try {
      const files = this.db.get('files').value();
      const totalFiles = files.length;
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      
      // Group by mime type
      const mimeTypes = {};
      files.forEach(file => {
        const mimeType = file.mimeType || 'unknown';
        mimeTypes[mimeType] = (mimeTypes[mimeType] || 0) + 1;
      });
      
      const mimeTypesArray = Object.entries(mimeTypes)
        .map(([mimeType, count]) => ({ mimeType, count }))
        .sort((a, b) => b.count - a.count);
      
      return {
        totalFiles,
        totalSize,
        mimeTypes: mimeTypesArray
      };
    } catch (error) {
      console.error('Error getting database stats:', error);
      return {
        totalFiles: 0,
        totalSize: 0,
        mimeTypes: []
      };
    }
  }

  // Search files by name or type
  searchFiles(query) {
    try {
      const files = this.db.get('files').value();
      const searchTerm = query.toLowerCase();
      
      const results = files.filter(file => 
        file.originalName.toLowerCase().includes(searchTerm) ||
        file.filename.toLowerCase().includes(searchTerm) ||
        file.mimeType.toLowerCase().includes(searchTerm)
      );
      
      console.log(`✅ Found ${results.length} files matching "${query}"`);
      return results;
    } catch (error) {
      console.error('❌ Error searching files:', error);
      return [];
    }
  }

  // Get files by mime type
  getFilesByType(mimeType) {
    try {
      const files = this.db.get('files').filter({ mimeType }).sortBy('uploadedAt').reverse().value();
      console.log(`✅ Retrieved ${files.length} files of type ${mimeType}`);
      return files;
    } catch (error) {
      console.error('❌ Error retrieving files by type:', error);
      return [];
    }
  }

  // Close database connection (lowdb doesn't need explicit closing)
  close() {
    console.log('✅ Database connection closed');
  }
}

module.exports = DatabaseService;