const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// POST /api/files/rename - Rename a file
export default function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { filename, newName } = req.body;
      
      if (!filename || !newName) {
        return res.status(400).json({ error: 'Filename and new name are required' });
      }

      if (newName.trim() === '') {
        return res.status(400).json({ error: 'New name cannot be empty' });
      }

      // Check if file exists
      const file = db.getFile(filename);
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }

      // Check if file with same name already exists in the same folder
      if (db.fileExistsInFolder(file.parentPath, newName.trim())) {
        return res.status(409).json({ error: 'A file with this name already exists in the folder' });
      }

      const success = db.renameFile(filename, newName.trim());
      
      if (success) {
        res.status(200).json({
          message: 'File renamed successfully',
          newName: newName.trim()
        });
      } else {
        res.status(500).json({ error: 'Failed to rename file' });
      }
    } catch (err) {
      console.error('Error renaming file:', err);
      res.status(500).json({ error: 'Failed to rename file' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
