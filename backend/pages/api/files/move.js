const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// POST /api/files/move - Move a file to a different folder
export default function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { filename, newParentPath = '/' } = req.body;
      
      if (!filename) {
        return res.status(400).json({ error: 'Filename is required' });
      }

      // Check if file exists
      const file = db.getFile(filename);
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }

      // Check if target folder exists (unless it's root)
      if (newParentPath !== '/' && !db.folderExists(newParentPath)) {
        return res.status(404).json({ error: 'Target folder does not exist' });
      }

      // Check if file with same name already exists in target folder
      if (db.fileExistsInFolder(newParentPath, file.name)) {
        return res.status(409).json({ error: 'A file with this name already exists in the target folder' });
      }

      const success = db.moveFile(filename, newParentPath);
      
      if (success) {
        res.status(200).json({
          message: 'File moved successfully',
          newPath: newParentPath === '/' ? `/${file.name}` : `${newParentPath}/${file.name}`
        });
      } else {
        res.status(500).json({ error: 'Failed to move file' });
      }
    } catch (err) {
      console.error('Error moving file:', err);
      res.status(500).json({ error: 'Failed to move file' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
