const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// GET /api/folders - List all folders
// POST /api/folders - Create a new folder
export default function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const folders = db.getAllFolders();
      res.status(200).json(folders);
    } catch (err) {
      console.error('Error fetching folders:', err);
      res.status(500).json({ error: 'Failed to fetch folders' });
    }
  } else if (req.method === 'POST') {
    try {
      const { name, parentPath = '/' } = req.body;
      
      if (!name || name.trim() === '') {
        return res.status(400).json({ error: 'Folder name is required' });
      }

      // Validate folder name (no special characters)
      if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) {
        return res.status(400).json({ error: 'Folder name contains invalid characters' });
      }

      const folderPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
      
      // Check if folder already exists
      if (db.folderExists(folderPath)) {
        return res.status(409).json({ error: 'Folder already exists' });
      }

      // Check if parent folder exists (unless it's root)
      if (parentPath !== '/' && !db.folderExists(parentPath)) {
        return res.status(404).json({ error: 'Parent folder does not exist' });
      }

      const folderInfo = {
        name: name.trim(),
        path: folderPath,
        parentPath
      };

      const success = db.createFolder(folderInfo);
      
      if (success) {
        // Create physical directory
        const fs = require('fs');
        const path = require('path');
        const physicalPath = path.join(db.uploadsDir, parentPath === '/' ? '' : parentPath, name);
        
        if (!fs.existsSync(physicalPath)) {
          fs.mkdirSync(physicalPath, { recursive: true });
        }

        res.status(201).json({
          message: 'Folder created successfully',
          folder: folderInfo
        });
      } else {
        res.status(500).json({ error: 'Failed to create folder' });
      }
    } catch (err) {
      console.error('Error creating folder:', err);
      res.status(500).json({ error: 'Failed to create folder' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
