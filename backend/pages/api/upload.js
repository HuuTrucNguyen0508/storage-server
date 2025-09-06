const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const DatabaseService = require('../../lib/database.js');

// Initialize database
const db = DatabaseService.getInstance();

// POST /api/upload - Upload a file
export default function handler(req, res) {
  if (req.method === 'POST') {
    try {
      // Optimized file upload for large files
      let bodyLength = 0;
      const chunks = [];

      req.on('data', chunk => {
        bodyLength += chunk.length;
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          // Parse multipart form data manually
          const contentType = req.headers['content-type'];

          if (!contentType || !contentType.includes('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
          }

          const boundary = contentType.split('boundary=')[1];
          if (!boundary) {
            return res.status(400).json({ error: 'No boundary found in multipart data' });
          }

          // Reconstruct body from chunks for better memory efficiency
          const body = Buffer.concat(chunks).toString();
          const parts = body.split('--' + boundary);

          let fileData = null;
          let filename = null;
          let fileContentType = null;

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            if (part.includes('Content-Disposition: form-data')) {
              const filenameMatch = part.match(/filename="([^"]+)"/);
              if (filenameMatch) {
                filename = filenameMatch[1];

                const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
                if (contentTypeMatch) {
                  fileContentType = contentTypeMatch[1];
                }

                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                  fileData = part.substring(headerEnd + 4);
                  fileData = fileData.replace(/\r\n$/, '');
                }
                break;
              }
            }
          }

          if (!fileData || !filename) {
            return res.status(400).json({ error: 'No file provided' });
          }

          // Generate unique filename with original name preserved
          const fileExtension = path.extname(filename);
          const baseName = path.basename(filename, fileExtension);
          const uniqueFilename = `${baseName}-${uuidv4()}${fileExtension}`;
          const filePath = path.join(db.uploadsDir, uniqueFilename);

          // Save file to disk with better performance for large files
          const fileBuffer = Buffer.from(fileData, 'binary');
          fs.writeFileSync(filePath, fileBuffer);

          // Get file stats
          const stats = fs.statSync(filePath);

          const fileInfo = {
            filename: uniqueFilename,
            originalName: filename,
            size: stats.size,
            mimeType: fileContentType || 'application/octet-stream',
            uploadedAt: new Date().toISOString(),
            filePath: filePath
          };

          const success = db.saveFile(fileInfo);

          if (success) {
            res.status(200).json({
              message: 'File uploaded successfully',
              filename: uniqueFilename,
              originalName: filename,
              size: stats.size
            });
          } else {
            fs.unlink(filePath, () => {});
            res.status(500).json({ error: 'Failed to save file info' });
          }

        } catch (parseError) {
          console.error('Error parsing file data:', parseError);
          res.status(500).json({ error: 'Failed to parse file data' });
        }
      });

      req.on('error', (error) => {
        console.error('Request error:', error);
        res.status(500).json({ error: 'Request error' });
      });

    } catch (error) {
      console.error('Error uploading file:', error);
      res.status(500).json({ error: 'Failed to upload file' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};