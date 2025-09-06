const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// GET /api/files - List all files
export default function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const files = db.getAllFiles();
      res.status(200).json(files);
    } catch (err) {
      console.error('Error fetching files:', err);
      res.status(500).json({ error: 'Failed to fetch files' });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

