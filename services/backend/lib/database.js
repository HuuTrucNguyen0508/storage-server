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
      if (!this.db.has('files').value() || !this.db.has('folders').value()) {
        // Check if the file contains an array (old format)
        const rawData = this.db.value();
        if (Array.isArray(rawData)) {
          // Convert old array format to new object format with folders
          this.db.setState({ 
            files: rawData.map(file => ({
              ...file,
              path: file.path || '/', // Add default path for existing files
              parentPath: file.parentPath || '/'
            })), 
            folders: [] 
          }).write();
        } else {
          // Initialize with empty structure
          this.db.defaults({ 
            files: [], 
            folders: [] 
          }).write();
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
        name: fileInfo.originalName, // Display name
        size: fileInfo.size,
        mimeType: fileInfo.mimeType,
        filePath: fileInfo.filePath,
        path: fileInfo.path || '/', // Full path including filename
        parentPath: fileInfo.parentPath || '/', // Parent folder path
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

  // ===== FOLDER MANAGEMENT METHODS =====

  // Create a new folder
  createFolder(folderInfo) {
    try {
      const folderData = {
        id: Date.now() + Math.random(),
        name: folderInfo.name,
        path: folderInfo.path,
        parentPath: folderInfo.parentPath || '/',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      this.db.get('folders').push(folderData).write();
      return true;
    } catch (error) {
      console.error('Error creating folder:', error);
      return false;
    }
  }

  // Get all folders
  getAllFolders() {
    try {
      const folders = this.db.get('folders').sortBy('path').value();
      return folders;
    } catch (error) {
      console.error('Error retrieving folders:', error);
      return [];
    }
  }

  // Get folders by parent path
  getFoldersByParent(parentPath) {
    try {
      const folders = this.db.get('folders')
        .filter({ parentPath })
        .sortBy('name')
        .value();
      return folders;
    } catch (error) {
      console.error('Error retrieving folders by parent:', error);
      return [];
    }
  }

  // Get files by parent path
  getFilesByParent(parentPath) {
    try {
      const files = this.db.get('files')
        .filter({ parentPath })
        .sortBy('name')
        .value();
      return files;
    } catch (error) {
      console.error('Error retrieving files by parent:', error);
      return [];
    }
  }

  // Get folder by path
  getFolderByPath(path) {
    try {
      const folder = this.db.get('folders').find({ path }).value();
      return folder;
    } catch (error) {
      console.error('Error retrieving folder by path:', error);
      return null;
    }
  }

  // Delete folder
  deleteFolder(path) {
    try {
      // First delete all files in this folder and subfolders
      const filesToDelete = this.db.get('files')
        .filter(file => file.path.startsWith(path + '/') || file.parentPath === path)
        .value();
      
      filesToDelete.forEach(file => {
        // Delete physical file
        try {
          if (fs.existsSync(file.filePath)) {
            fs.unlinkSync(file.filePath);
          }
        } catch (err) {
          console.error('Error deleting physical file:', err);
        }
      });

      // Delete files from database
      this.db.get('files')
        .remove(file => file.path.startsWith(path + '/') || file.parentPath === path)
        .write();

      // Delete subfolders
      this.db.get('folders')
        .remove(folder => folder.path.startsWith(path + '/') || folder.parentPath === path)
        .write();

      // Delete the folder itself
      const result = this.db.get('folders').remove({ path }).write();
      return result.length > 0;
    } catch (error) {
      console.error('Error deleting folder:', error);
      return false;
    }
  }

  // Rename folder
  renameFolder(oldPath, newPath, newName) {
    try {
      // Update folder
      const folder = this.db.get('folders').find({ path: oldPath }).value();
      if (!folder) return false;

      folder.name = newName;
      folder.path = newPath;
      folder.updatedAt = new Date().toISOString();
      this.db.get('folders').find({ path: oldPath }).assign(folder).write();

      // Update all files in this folder
      this.db.get('files')
        .filter(file => file.parentPath === oldPath)
        .forEach(file => {
          file.parentPath = newPath;
          file.path = newPath + '/' + file.name;
          file.updatedAt = new Date().toISOString();
        })
        .write();

      // Update all subfolders
      this.db.get('folders')
        .filter(folder => folder.parentPath === oldPath)
        .forEach(subfolder => {
          subfolder.parentPath = newPath;
          subfolder.path = newPath + '/' + subfolder.name;
          subfolder.updatedAt = new Date().toISOString();
        })
        .write();

      return true;
    } catch (error) {
      console.error('Error renaming folder:', error);
      return false;
    }
  }

  // Move file to different folder
  moveFile(filename, newParentPath) {
    try {
      const file = this.db.get('files').find({ filename }).value();
      if (!file) return false;

      const newPath = newParentPath === '/' ? `/${file.name}` : `${newParentPath}/${file.name}`;
      
      // Update file in database
      file.parentPath = newParentPath;
      file.path = newPath;
      file.updatedAt = new Date().toISOString();
      
      this.db.get('files').find({ filename }).assign(file).write();

      // Move physical file
      const newFilePath = path.join(this.uploadsDir, newParentPath === '/' ? '' : newParentPath, file.filename);
      const newDir = path.dirname(newFilePath);
      
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }
      
      if (fs.existsSync(file.filePath)) {
        fs.renameSync(file.filePath, newFilePath);
        file.filePath = newFilePath;
        this.db.get('files').find({ filename }).assign(file).write();
      }

      return true;
    } catch (error) {
      console.error('Error moving file:', error);
      return false;
    }
  }

  // Rename file
  renameFile(filename, newName) {
    try {
      const file = this.db.get('files').find({ filename }).value();
      if (!file) return false;

      const newPath = file.parentPath === '/' ? `/${newName}` : `${file.parentPath}/${newName}`;
      
      // Update file in database
      file.name = newName;
      file.originalName = newName;
      file.path = newPath;
      file.updatedAt = new Date().toISOString();
      
      this.db.get('files').find({ filename }).assign(file).write();

      return true;
    } catch (error) {
      console.error('Error renaming file:', error);
      return false;
    }
  }

  // Get folder tree structure
  getFolderTree() {
    try {
      const folders = this.getAllFolders();
      const rootFolders = folders.filter(folder => folder.parentPath === '/');
      
      const buildTree = (parentPath) => {
        const children = folders.filter(folder => folder.parentPath === parentPath);
        return children.map(folder => ({
          ...folder,
          children: buildTree(folder.path)
        }));
      };

      return buildTree('/');
    } catch (error) {
      console.error('Error building folder tree:', error);
      return [];
    }
  }

  // Check if folder exists
  folderExists(path) {
    try {
      const folder = this.db.get('folders').find({ path }).value();
      return !!folder;
    } catch (error) {
      console.error('Error checking folder existence:', error);
      return false;
    }
  }

  // Check if file exists in folder
  fileExistsInFolder(parentPath, name) {
    try {
      const file = this.db.get('files').find({ parentPath, name }).value();
      return !!file;
    } catch (error) {
      console.error('Error checking file existence:', error);
      return false;
    }
  }

  // Close database connection (lowdb doesn't need explicit closing)
  close() {
    console.log('✅ Database connection closed');
  }
}

module.exports = DatabaseService;