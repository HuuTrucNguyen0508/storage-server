const DatabaseService = require('../../../lib/database.js');
const fs = require('fs');
const path = require('path');

// Initialize database
const db = DatabaseService.getInstance();

// DELETE /api/folders/[path] - Delete a folder
// PUT /api/folders/[path] - Rename a folder
export default function handler(req, res) {
  const { path: folderPath } = req.query;
  
  if (!folderPath) {
    return res.status(400).json({ error: 'Folder path is required' });
  }

  // Decode the path
  const decodedPath = decodeURIComponent(folderPath);

  if (req.method === 'DELETE') {
    try {
      // Check if folder exists
      if (!db.folderExists(decodedPath)) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      const success = db.deleteFolder(decodedPath);
      
      if (success) {
        // Delete physical directory
        const physicalPath = path.join(db.uploadsDir, decodedPath === '/' ? '' : decodedPath);
        if (fs.existsSync(physicalPath)) {
          fs.rmSync(physicalPath, { recursive: true, force: true });
        }

        res.status(200).json({ message: 'Folder deleted successfully' });
      } else {
        res.status(500).json({ error: 'Failed to delete folder' });
      }
    } catch (err) {
      console.error('Error deleting folder:', err);
      res.status(500).json({ error: 'Failed to delete folder' });
    }
  } else if (req.method === 'PUT') {
    try {
      const { newName } = req.body;
      
      if (!newName || newName.trim() === '') {
        return res.status(400).json({ error: 'New folder name is required' });
      }

      // Validate folder name
      if (!/^[a-zA-Z0-9\s\-_]+$/.test(newName)) {
        return res.status(400).json({ error: 'Folder name contains invalid characters' });
      }

      // Check if folder exists
      if (!db.folderExists(decodedPath)) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      const folder = db.getFolderByPath(decodedPath);
      if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      const parentPath = folder.parentPath;
      const newPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;

      // Check if new name already exists in parent folder
      if (db.folderExists(newPath)) {
        return res.status(409).json({ error: 'A folder with this name already exists' });
      }

      const success = db.renameFolder(decodedPath, newPath, newName.trim());
      
      if (success) {
        // Rename physical directory
        const oldPhysicalPath = path.join(db.uploadsDir, decodedPath === '/' ? '' : decodedPath);
        const newPhysicalPath = path.join(db.uploadsDir, newPath === '/' ? '' : newPath);
        
        if (fs.existsSync(oldPhysicalPath)) {
          fs.renameSync(oldPhysicalPath, newPhysicalPath);
        }

        res.status(200).json({
          message: 'Folder renamed successfully',
          newPath,
          newName: newName.trim()
        });
      } else {
        res.status(500).json({ error: 'Failed to rename folder' });
      }
    } catch (err) {
      console.error('Error renaming folder:', err);
      res.status(500).json({ error: 'Failed to rename folder' });
    }
  } else {
    res.setHeader('Allow', ['DELETE', 'PUT']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
