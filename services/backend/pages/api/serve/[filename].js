const path = require('path');
const fs = require('fs');
const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// GET /api/serve/[filename] - Serve files directly without Next.js limitations
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

      // Get file stats
      const stats = fs.statSync(filePath);
      
      // Set headers for file download
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
      res.setHeader('Content-Length', stats.size.toString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Handle range requests for large files
      const range = req.headers.range;
      let fileStream;
      
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunksize = (end - start) + 1;
        
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
        res.setHeader('Content-Length', chunksize.toString());
        
        fileStream = fs.createReadStream(filePath, { start, end });
      } else {
        // Stream the entire file
        fileStream = fs.createReadStream(filePath);
      }
      
      // Handle stream errors
      fileStream.on('error', (streamError) => {
        console.error('File stream error:', streamError);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error reading file' });
        }
      });
      
      fileStream.pipe(res);
      
    } catch (err) {
      console.error('Error serving file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to serve file' });
      }
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

// Disable Next.js body parsing for this route
export const config = {
  api: {
    bodyParser: false,
  },
};
