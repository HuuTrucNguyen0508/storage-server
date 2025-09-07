const path = require('path');
const fs = require('fs');
const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// GET /api/files/[filename] - Download a specific file
export default function handler(req, res) {
  if (req.method === 'GET') {
    const { filename } = req.query;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    try {
      // Get file info from database
      const file = db.getFile(filename);
      
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }

      // Check if file exists on filesystem
      const filePath = file.filePath;
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on filesystem' });
      }

      // Set headers for file download
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
      res.setHeader('Content-Length', file.size.toString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');

      // Stream the file with error handling
      const fileStream = fs.createReadStream(filePath);
      
      fileStream.on('error', (streamError) => {
        console.error('File stream error:', streamError);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error reading file' });
        }
      });
      
      fileStream.pipe(res);
    } catch (err) {
      console.error('Error downloading file:', err);
      res.status(500).json({ error: 'Failed to download file' });
    }
  } else if (req.method === 'DELETE') {
    const { filename } = req.query;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    try {
      // Check if file exists
      const file = db.getFile(filename);
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }

      // Delete file from filesystem
      const filePath = file.filePath;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`✅ File deleted from filesystem: ${filePath}`);
      }

      // Delete file from database
      const success = db.deleteFile(filename);
      if (success) {
        res.status(200).json({ message: 'File deleted successfully' });
      } else {
        res.status(500).json({ error: 'Failed to delete file from database' });
      }
    } catch (err) {
      console.error('Error deleting file:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
