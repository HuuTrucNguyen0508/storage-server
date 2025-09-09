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
      // Collect all data chunks
      let bodyLength = 0;
      const chunks = [];

      req.on('data', chunk => {
        bodyLength += chunk.length;
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          // Parse multipart form data manually but handle binary data correctly
          const contentType = req.headers['content-type'];

          if (!contentType || !contentType.includes('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
          }

          const boundary = contentType.split('boundary=')[1];
          if (!boundary) {
            return res.status(400).json({ error: 'No boundary found in multipart data' });
          }

          // Convert to string for parsing but keep track of binary data
          const body = Buffer.concat(chunks);
          const bodyString = body.toString('binary');
          const parts = bodyString.split('--' + boundary);

          let fileData = null;
          let filename = null;
          let fileContentType = null;
          let headerStart = 0;
          let headerEnd = 0;

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

                // Find the end of headers (double CRLF)
                const headerEndMatch = part.indexOf('\r\n\r\n');
                if (headerEndMatch !== -1) {
                  headerStart = headerEndMatch + 4; // Skip the double CRLF
                  // Find the end of this part (before the next boundary or end)
                  let dataEnd = part.length;
                  if (i < parts.length - 1) {
                    // Remove trailing CRLF if present
                    if (part.endsWith('\r\n')) {
                      dataEnd = part.length - 2;
                    }
                  }
                  
                  // Extract file data as string slice, then convert back to Buffer
                  const fileDataString = part.slice(headerStart, dataEnd);
                  fileData = Buffer.from(fileDataString, 'binary');
                  break;
                }
              }
            }
          }

          if (!fileData || !filename) {
            return res.status(400).json({ error: 'No file provided' });
          }

          // Get folder path from form data
          let folderPath = '/';
          const folderPathMatch = bodyString.match(/name="folderPath"\r\n\r\n([^\r\n]+)/);
          if (folderPathMatch) {
            folderPath = folderPathMatch[1];
          }

          // Generate unique filename with original name preserved
          const fileExtension = path.extname(filename);
          const baseName = path.basename(filename, fileExtension);
          const uniqueFilename = `${baseName}-${uuidv4()}${fileExtension}`;
          
          // Create directory if it doesn't exist
          const targetDir = path.join(db.uploadsDir, folderPath === '/' ? '' : folderPath);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          
          const filePath = path.join(targetDir, uniqueFilename);

          // Write file data directly as Buffer (preserves binary data)
          fs.writeFileSync(filePath, fileData);

          // Get file stats
          const stats = fs.statSync(filePath);

          const fileInfo = {
            filename: uniqueFilename,
            originalName: filename,
            size: stats.size,
            mimeType: fileContentType || 'application/octet-stream',
            uploadedAt: new Date().toISOString(),
            filePath: filePath,
            path: folderPath === '/' ? `/${filename}` : `${folderPath}/${filename}`,
            parentPath: folderPath
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