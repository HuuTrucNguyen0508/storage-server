import { useState, useEffect } from 'react'
import axios from 'axios'

// Dynamic API URL based on current hostname
const API_BASE_URL = `${window.location.protocol}//${window.location.host}/api`

function App() {
  const [files, setFiles] = useState([])
  const [folders, setFolders] = useState([])
  const [currentPath, setCurrentPath] = useState('/')
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [availableFolders, setAvailableFolders] = useState([])

  // Fetch files and folders on component mount
  useEffect(() => {
    fetchData()
  }, [currentPath])

  const fetchData = async () => {
    try {
      setLoading(true)
      const [filesResponse, foldersResponse] = await Promise.all([
        axios.get(`${API_BASE_URL}/files?path=${encodeURIComponent(currentPath)}`),
        axios.get(`${API_BASE_URL}/folders`)
      ])
      setFiles(filesResponse.data)
      setFolders(foldersResponse.data)
      setError('')
    } catch (err) {
      setError('Failed to fetch data')
      console.error('Error fetching data:', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchFiles = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/files?path=${encodeURIComponent(currentPath)}`)
      setFiles(response.data)
    } catch (err) {
      setError('Failed to fetch files')
      console.error('Error fetching files:', err)
    }
  }

  const handleFileUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    const formData = new FormData()
    formData.append('file', file)
    formData.append('folderPath', currentPath)

    try {
      setUploading(true)
      setError('')

      const response = await axios.post(`${API_BASE_URL}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })

      await fetchData() // Refresh the data
    } catch (err) {
      console.error('Upload failed:', err)
      setError(`Failed to upload file: ${err.response?.data?.error || err.message}`)
    } finally {
      setUploading(false)
      event.target.value = '' // Reset file input
    }
  }

  const handleFileDownload = async (filename) => {
    try {
      // Use direct file serving through nginx (bypasses Next.js limitations)
      const downloadUrl = `${window.location.protocol}//${window.location.host}/files/${filename}`
      
      // Create a direct download link
      const link = document.createElement('a')
      link.href = downloadUrl
      link.setAttribute('download', filename)
      link.setAttribute('target', '_blank')
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (err) {
      setError('Failed to download file')
      console.error('Error downloading file:', err)
    }
  }

  const handleFileDelete = async (filename) => {
    if (!window.confirm(`Are you sure you want to delete ${filename}?`)) {
      return
    }

    try {
      await axios.delete(`${API_BASE_URL}/files/${filename}`)
      await fetchFiles() // Refresh the file list
      setError('')
    } catch (err) {
      setError('Failed to delete file')
      console.error('Error deleting file:', err)
    }
  }

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString()
  }

  // ===== FOLDER MANAGEMENT FUNCTIONS =====

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return

    try {
      await axios.post(`${API_BASE_URL}/folders`, {
        name: newFolderName.trim(),
        parentPath: currentPath
      })
      
      setNewFolderName('')
      setShowCreateFolder(false)
      await fetchData()
    } catch (err) {
      setError(`Failed to create folder: ${err.response?.data?.error || err.message}`)
    }
  }

  const handleDeleteFolder = async (folderPath) => {
    if (!window.confirm(`Are you sure you want to delete this folder and all its contents?`)) {
      return
    }

    try {
      await axios.delete(`${API_BASE_URL}/folders/${encodeURIComponent(folderPath)}`)
      await fetchData()
    } catch (err) {
      setError(`Failed to delete folder: ${err.response?.data?.error || err.message}`)
    }
  }

  const handleRenameFolder = async (folderPath, newName) => {
    try {
      await axios.put(`${API_BASE_URL}/folders/${encodeURIComponent(folderPath)}`, {
        newName: newName.trim()
      })
      await fetchData()
    } catch (err) {
      setError(`Failed to rename folder: ${err.response?.data?.error || err.message}`)
    }
  }

  const handleFolderClick = (folderPath) => {
    setCurrentPath(folderPath)
  }

  const handleBackClick = () => {
    if (currentPath !== '/') {
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/'
      setCurrentPath(parentPath)
    }
  }

  const getBreadcrumbs = () => {
    if (currentPath === '/') return [{ name: 'Root', path: '/' }]
    
    const parts = currentPath.split('/').filter(part => part)
    const breadcrumbs = [{ name: 'Root', path: '/' }]
    
    let currentBreadcrumbPath = ''
    parts.forEach(part => {
      currentBreadcrumbPath += `/${part}`
      breadcrumbs.push({ name: part, path: currentBreadcrumbPath })
    })
    
    return breadcrumbs
  }

  // ===== FILE MANAGEMENT FUNCTIONS =====

  const handleRenameFile = async () => {
    if (!selectedFile || !newFileName.trim()) return

    try {
      await axios.post(`${API_BASE_URL}/files/rename`, {
        filename: selectedFile.filename,
        newName: newFileName.trim()
      })
      
      setShowRenameModal(false)
      setSelectedFile(null)
      setNewFileName('')
      await fetchFiles()
    } catch (err) {
      setError(`Failed to rename file: ${err.response?.data?.error || err.message}`)
    }
  }

  const handleMoveFile = async () => {
    if (!selectedFile) return

    try {
      await axios.post(`${API_BASE_URL}/files/move`, {
        filename: selectedFile.filename,
        newParentPath: currentPath
      })
      
      setShowMoveModal(false)
      setSelectedFile(null)
      await fetchFiles()
    } catch (err) {
      setError(`Failed to move file: ${err.response?.data?.error || err.message}`)
    }
  }

  const openRenameModal = (file) => {
    setSelectedFile(file)
    setNewFileName(file.name)
    setShowRenameModal(true)
  }

  const openMoveModal = async (file) => {
    setSelectedFile(file)
    try {
      const response = await axios.get(`${API_BASE_URL}/folders`)
      setAvailableFolders(response.data)
      setShowMoveModal(true)
    } catch (err) {
      setError('Failed to load folders')
    }
  }

  const getFileIcon = (mimeType) => {
    if (mimeType.startsWith('image/')) return '🖼️'
    if (mimeType.startsWith('video/')) return '🎥'
    if (mimeType.startsWith('audio/')) return '🎵'
    if (mimeType.includes('pdf')) return '📄'
    if (mimeType.includes('text/')) return '📝'
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦'
    return '📄'
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 mb-2">
              File Storage System
            </h1>
            <p className="text-gray-600">
              Upload, manage, and organize your files with folders
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Sidebar - Folder Tree */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg shadow-md p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-800">Folders</h3>
                  <button
                    onClick={() => setShowCreateFolder(true)}
                    className="text-blue-600 hover:text-blue-800 text-sm"
                  >
                    + New Folder
                  </button>
                </div>
                
                {/* Breadcrumbs */}
                <div className="mb-4">
                  <nav className="flex" aria-label="Breadcrumb">
                    <ol className="flex items-center space-x-1">
                      {getBreadcrumbs().map((crumb, index) => (
                        <li key={index} className="flex items-center">
                          {index > 0 && <span className="text-gray-400 mx-1">/</span>}
                          <button
                            onClick={() => handleFolderClick(crumb.path)}
                            className={`text-sm ${
                              crumb.path === currentPath
                                ? 'text-blue-600 font-medium'
                                : 'text-gray-500 hover:text-gray-700'
                            }`}
                          >
                            {crumb.name}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </nav>
                </div>

                {/* Back Button */}
                {currentPath !== '/' && (
                  <button
                    onClick={handleBackClick}
                    className="w-full text-left px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded mb-2"
                  >
                    ← Back
                  </button>
                )}

                {/* Current Folder Contents */}
                <div className="space-y-1">
                  {folders
                    .filter(folder => folder.parentPath === currentPath)
                    .map(folder => (
                      <div key={folder.id} className="flex items-center justify-between group">
                        <button
                          onClick={() => handleFolderClick(folder.path)}
                          className="flex items-center flex-1 text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
                        >
                          <span className="mr-2">📁</span>
                          {folder.name}
                        </button>
                        <div className="opacity-0 group-hover:opacity-100 flex space-x-1">
                          <button
                            onClick={() => {
                              const newName = prompt('Enter new folder name:', folder.name)
                              if (newName && newName !== folder.name) {
                                handleRenameFolder(folder.path, newName)
                              }
                            }}
                            className="text-blue-600 hover:text-blue-800 text-xs"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => handleDeleteFolder(folder.path)}
                            className="text-red-600 hover:text-red-800 text-xs"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            {/* Main Content */}
            <div className="lg:col-span-3">
              {/* Upload Section */}
              <div className="bg-white rounded-lg shadow-md p-6 mb-6">
                <h2 className="text-2xl font-semibold text-gray-800 mb-4">
                  Upload File to {currentPath === '/' ? 'Root' : currentPath}
                </h2>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-gray-400 transition-colors">
                  <input
                    type="file"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    className="hidden"
                    id="file-upload"
                  />
                  <label
                    htmlFor="file-upload"
                    className={`cursor-pointer inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white ${
                      uploading
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {uploading ? 'Uploading...' : 'Choose File to Upload'}
                  </label>
                  <p className="mt-2 text-sm text-gray-500">
                    Click to select a file from your computer
                  </p>
                </div>
              </div>

              {/* Files and Folders Grid */}
              <div className="bg-white rounded-lg shadow-md">
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="text-2xl font-semibold text-gray-800">
                    Contents of {currentPath === '/' ? 'Root' : currentPath}
                  </h2>
                </div>
                
                {loading ? (
                  <div className="p-6 text-center">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                    <p className="mt-2 text-gray-600">Loading...</p>
                  </div>
                ) : files.length === 0 && folders.filter(f => f.parentPath === currentPath).length === 0 ? (
                  <div className="p-6 text-center text-gray-500">
                    <p>This folder is empty.</p>
                    <p className="text-sm">Upload files or create folders to get started.</p>
                  </div>
                ) : (
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                      {/* Folders */}
                      {folders
                        .filter(folder => folder.parentPath === currentPath)
                        .map(folder => (
                          <div key={folder.id} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
                            <div className="text-center">
                              <div className="text-4xl mb-2">📁</div>
                              <h3 className="font-medium text-gray-900 truncate" title={folder.name}>
                                {folder.name}
                              </h3>
                              <p className="text-xs text-gray-500">Folder</p>
                              <div className="mt-2 flex justify-center space-x-2">
                                <button
                                  onClick={() => handleFolderClick(folder.path)}
                                  className="text-blue-600 hover:text-blue-800 text-xs"
                                >
                                  Open
                                </button>
                                <button
                                  onClick={() => {
                                    const newName = prompt('Enter new folder name:', folder.name)
                                    if (newName && newName !== folder.name) {
                                      handleRenameFolder(folder.path, newName)
                                    }
                                  }}
                                  className="text-yellow-600 hover:text-yellow-800 text-xs"
                                >
                                  Rename
                                </button>
                                <button
                                  onClick={() => handleDeleteFolder(folder.path)}
                                  className="text-red-600 hover:text-red-800 text-xs"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}

                      {/* Files */}
                      {files.map((file, index) => (
                        <div key={index} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
                          <div className="text-center">
                            <div className="text-4xl mb-2">{getFileIcon(file.mimeType)}</div>
                            <h3 className="font-medium text-gray-900 truncate" title={file.name}>
                              {file.name}
                            </h3>
                            <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                            <div className="mt-2 flex justify-center space-x-1">
                              <button
                                onClick={() => handleFileDownload(file.filename)}
                                className="text-blue-600 hover:text-blue-800 text-xs"
                              >
                                Download
                              </button>
                              <button
                                onClick={() => openRenameModal(file)}
                                className="text-yellow-600 hover:text-yellow-800 text-xs"
                              >
                                Rename
                              </button>
                              <button
                                onClick={() => openMoveModal(file)}
                                className="text-green-600 hover:text-green-800 text-xs"
                              >
                                Move
                              </button>
                              <button
                                onClick={() => handleFileDelete(file.filename)}
                                className="text-red-600 hover:text-red-800 text-xs"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">Create New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex justify-end space-x-2 mt-4">
              <button
                onClick={() => {
                  setShowCreateFolder(false)
                  setNewFolderName('')
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename File Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">Rename File</h3>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="New file name"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex justify-end space-x-2 mt-4">
              <button
                onClick={() => {
                  setShowRenameModal(false)
                  setSelectedFile(null)
                  setNewFileName('')
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleRenameFile}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move File Modal */}
      {showMoveModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">Move File</h3>
            <p className="text-sm text-gray-600 mb-4">
              Move "{selectedFile?.name}" to:
            </p>
            <select
              value={currentPath}
              onChange={(e) => setCurrentPath(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="/">Root</option>
              {availableFolders.map(folder => (
                <option key={folder.id} value={folder.path}>
                  {folder.path}
                </option>
              ))}
            </select>
            <div className="flex justify-end space-x-2 mt-4">
              <button
                onClick={() => {
                  setShowMoveModal(false)
                  setSelectedFile(null)
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleMoveFile}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
