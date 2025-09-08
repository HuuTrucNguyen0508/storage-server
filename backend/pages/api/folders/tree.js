const DatabaseService = require('../../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// GET /api/folders/tree - Get folder tree structure
export default function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const folderTree = db.getFolderTree();
      res.status(200).json(folderTree);
    } catch (err) {
      console.error('Error fetching folder tree:', err);
      res.status(500).json({ error: 'Failed to fetch folder tree' });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
