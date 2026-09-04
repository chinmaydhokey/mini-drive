import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import toast from 'react-hot-toast';
import {
  HiOutlineCloudArrowUp, HiOutlineFolderPlus, HiOutlineChevronRight,
  HiOutlineDocument, HiOutlineFolder, HiOutlinePhoto, HiOutlineFilm,
  HiOutlineMusicalNote, HiOutlineArchiveBox, HiOutlineCodeBracket,
  HiOutlineDocumentText, HiOutlineEllipsisVertical,
  HiOutlineArrowDownTray, HiOutlinePencil, HiOutlineShare,
  HiOutlineTrash, HiOutlineClock, HiOutlineLink, HiOutlineCheckCircle,
  HiOutlineLockClosed, HiOutlineGlobeAlt, HiOutlineUserPlus, HiOutlineXMark,
} from 'react-icons/hi2';
import { filesAPI, foldersAPI, sharesAPI, bulkAPI } from '../services/api';
import UploadManager from '../components/UploadManager';

function getFileIcon(mimeType, isFolder) {
  if (isFolder) return { icon: HiOutlineFolder, cls: 'file-type-folder' };
  if (!mimeType) return { icon: HiOutlineDocument, cls: 'file-type-other' };
  if (mimeType.startsWith('image/')) return { icon: HiOutlinePhoto, cls: 'file-type-image' };
  if (mimeType.startsWith('video/')) return { icon: HiOutlineFilm, cls: 'file-type-video' };
  if (mimeType.startsWith('audio/')) return { icon: HiOutlineMusicalNote, cls: 'file-type-audio' };
  if (mimeType.includes('pdf')) return { icon: HiOutlineDocumentText, cls: 'file-type-pdf' };
  if (mimeType.startsWith('text/')) return { icon: HiOutlineDocumentText, cls: 'file-type-text' };
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar'))
    return { icon: HiOutlineArchiveBox, cls: 'file-type-archive' };
  if (mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml'))
    return { icon: HiOutlineCodeBracket, cls: 'file-type-code' };
  return { icon: HiOutlineDocument, cls: 'file-type-other' };
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folderId = searchParams.get('folder') || 'root';
  const [folderData, setFolderData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [renameModal, setRenameModal] = useState(null);
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [shareModal, setShareModal] = useState(null);
  const [versionModal, setVersionModal] = useState(null);
  
  // Chunked upload state
  const [pendingChunkedFiles, setPendingChunkedFiles] = useState([]);
  const CHUNKED_THRESHOLD = 10 * 1024 * 1024; // 10 MB — files above this use chunked upload
  
  // Selection state
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [lastSelected, setLastSelected] = useState(null);
  
  const contextRef = useRef(null);
  const navigate = useNavigate();

  const loadFolder = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await foldersAPI.getContents(folderId);
      setFolderData(data.data);
    } catch (err) {
      toast.error('Failed to load folder.');
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    setSelectedItems(new Set());
    setLastSelected(null);
    loadFolder();
  }, [loadFolder]);

  // Close context menu on click outside
  useEffect(() => {
    const handler = (e) => {
      if (contextRef.current && !contextRef.current.contains(e.target)) setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Upload via dropzone ────────────────────────────────────
  const onDrop = useCallback(async (files) => {
    const smallFiles = [];
    const largeFiles = [];

    for (const file of files) {
      if (file.size > CHUNKED_THRESHOLD) {
        largeFiles.push(file);
      } else {
        smallFiles.push(file);
      }
    }

    // Large files → chunked upload engine (via UploadManager)
    if (largeFiles.length > 0) {
      setPendingChunkedFiles(prev => [
        ...prev,
        ...largeFiles.map(file => ({
          file,
          folderId: folderId !== 'root' ? folderId : undefined,
          encrypt: false,
        })),
      ]);
    }

    // Small files → simple single-request upload (existing path)
    for (const file of smallFiles) {
      const formData = new FormData();
      formData.append('file', file);
      if (folderId !== 'root') formData.append('folderId', folderId);

      try {
        setUploadProgress({ name: file.name, percent: 0 });
        await filesAPI.upload(formData, (e) => {
          setUploadProgress({ name: file.name, percent: Math.round((e.loaded / e.total) * 100) });
        });
        toast.success(`Uploaded "${file.name}"`);
      } catch (err) {
        toast.error(err.response?.data?.error?.message || `Upload failed: ${file.name}`);
      }
    }
    setUploadProgress(null);
    if (smallFiles.length > 0) loadFolder();
  }, [folderId, loadFolder]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, noClick: true, noKeyboard: true,
  });

  // ── Folder navigation ──────────────────────────────────────
  const openFolder = (id) => setSearchParams({ folder: id });
  const openBreadcrumb = (id) => setSearchParams(id === 'root' ? {} : { folder: id });

  // ── Selection actions ──────────────────────────────────────
  const toggleSelect = (id, type, event) => {
    event.stopPropagation();
    const itemId = `${type}:${id}`;
    
    setSelectedItems(prev => {
      const newSelection = new Set(prev);
      const allItems = [
        ...(folderData?.subfolders || []).map(f => `folder:${f._id}`),
        ...(folderData?.files || []).map(f => `file:${f._id}`)
      ];
      
      if (event.shiftKey && lastSelected) {
        const lastIdx = allItems.indexOf(lastSelected);
        const currentIdx = allItems.indexOf(itemId);
        
        if (lastIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(lastIdx, currentIdx);
          const end = Math.max(lastIdx, currentIdx);
          
          if (!event.ctrlKey && !event.metaKey) {
            newSelection.clear();
          }
          
          for (let i = start; i <= end; i++) {
            newSelection.add(allItems[i]);
          }
          return newSelection;
        }
      }
      
      if (event.ctrlKey || event.metaKey) {
        if (newSelection.has(itemId)) {
          newSelection.delete(itemId);
        } else {
          newSelection.add(itemId);
        }
      } else {
        if (newSelection.has(itemId) && newSelection.size === 1) {
          newSelection.clear();
        } else {
          newSelection.clear();
          newSelection.add(itemId);
        }
      }
      
      return newSelection;
    });
    setLastSelected(itemId);
  };

  const handleSelectAll = () => {
    const allItems = [
      ...(folderData?.subfolders || []).map(f => `folder:${f._id}`),
      ...(folderData?.files || []).map(f => `file:${f._id}`)
    ];
    if (selectedItems.size === allItems.length && allItems.length > 0) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(allItems));
    }
  };

  const handleBulkDelete = async () => {
    try {
      const ids = Array.from(selectedItems).map(key => {
        const [type, id] = key.split(':');
        return { id, type };
      });
      const { data } = await bulkAPI.softDelete(ids);
      const succeeded = data.data?.summary?.succeeded || 0;
      const failed = data.data?.summary?.failed || 0;
      if (succeeded > 0) {
        toast.success(`${succeeded} item(s) moved to trash.`);
      }
      if (failed > 0) {
        toast.error(`${failed} item(s) failed to delete.`);
      }
      setSelectedItems(new Set());
      loadFolder();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Bulk delete failed.');
    }
  };

  const handleBulkDownload = async () => {
    try {
      // Collect file IDs directly selected
      const selectedFileIds = Array.from(selectedItems)
        .filter(key => key.startsWith('file:'))
        .map(key => key.split(':')[1]);

      // For selected folders, gather all files inside them recursively
      const selectedFolderIds = Array.from(selectedItems)
        .filter(key => key.startsWith('folder:'))
        .map(key => key.split(':')[1]);

      // Fetch files from selected folders recursively
      const folderFileIds = [];
      const visitedFolders = new Set();
      const queue = [...selectedFolderIds];

      while (queue.length > 0) {
        const fid = queue.shift();
        if (visitedFolders.has(fid)) continue;
        visitedFolders.add(fid);
        try {
          const { data } = await foldersAPI.getContents(fid);
          const folderFiles = data.data?.files || [];
          folderFileIds.push(...folderFiles.map(f => f._id));
          const subfolders = data.data?.subfolders || [];
          for (const sub of subfolders) {
            if (!visitedFolders.has(sub._id)) {
              queue.push(sub._id);
            }
          }
        } catch {
          // folder fetch failed, skip
        }
      }

      const allFileIds = [...new Set([...selectedFileIds, ...folderFileIds])];

      if (allFileIds.length === 0) {
        toast.error('No files found for download.');
        return;
      }

      const response = await bulkAPI.downloadZip(allFileIds);

      // Check if the response is a JSON error disguised as blob
      if (response.data instanceof Blob && response.data.type === 'application/json') {
        const text = await response.data.text();
        const errObj = JSON.parse(text);
        toast.error(errObj.error?.message || 'Download failed.');
        return;
      }

      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MiniDrive_${allFileIds.length}_files.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setSelectedItems(new Set());
    } catch (err) {
      // Handle blob error responses from axios
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const errObj = JSON.parse(text);
          toast.error(errObj.error?.message || 'Bulk download failed.');
        } catch {
          toast.error('Bulk download failed.');
        }
      } else {
        toast.error(err.response?.data?.error?.message || 'Bulk download failed.');
      }
    }
  };

  const handleBulkShare = async () => {
    const fileIds = Array.from(selectedItems)
      .filter(key => key.startsWith('file:'))
      .map(key => key.split(':')[1]);
    const folderIds = Array.from(selectedItems)
      .filter(key => key.startsWith('folder:'))
      .map(key => key.split(':')[1]);
    if (fileIds.length === 0 && folderIds.length === 0) {
      toast.error('No items selected for sharing.');
      return;
    }
    setShareModal({ fileIds, folderIds, isBatch: true });
  };

  // ── Context menu actions ───────────────────────────────────
  const handleContextMenu = (e, item, type) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, item, type });
  };

  const handleDownload = async (file) => {
    setContextMenu(null);
    try {
      // If file is encrypted, decrypt client-side
      if (file.isEncrypted) {
        const password = prompt('Enter vault password to decrypt this file:');
        if (!password) return;

        const { deriveKey, decryptChunk, base64ToBytes } = await import('../services/cryptoEngine');

        toast('Decrypting file...', { icon: '🔐', duration: 2000 });

        // Get file metadata (includes encryptionSalt and chunkIVs)
        const { data: metaRes } = await filesAPI.get(file._id);
        const fileMeta = metaRes.data.file;

        if (!fileMeta.encryptionSalt || !fileMeta.chunkIVs?.length) {
          toast.error('Missing encryption metadata. File may not be decryptable.');
          return;
        }

        const salt = base64ToBytes(fileMeta.encryptionSalt);
        const key = await deriveKey(password, salt);

        // Download and decrypt each chunk
        const decryptedParts = [];
        for (let i = 0; i < (fileMeta.totalChunks || fileMeta.chunkIVs.length); i++) {
          const { data: chunkBlob } = await filesAPI.download(file._id);
          // For chunked files, we download the whole reassembled file from the server
          // and decrypt it chunk-by-chunk based on the IVs
          // But since the server streams all chunks concatenated, we handle it differently:
          break; // will use single download approach below
        }

        // Download entire (encrypted) file as blob
        const { data: encBlob } = await filesAPI.download(file._id);
        const encBuffer = await encBlob.arrayBuffer();

        // If file has chunk IVs, decrypt chunk by chunk
        const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB (must match upload chunk size)
        const GCM_TAG_SIZE = 16; // AES-GCM auth tag appended by encrypt
        const chunkIVs = fileMeta.chunkIVs;
        const parts = [];
        let offset = 0;

        for (let i = 0; i < chunkIVs.length; i++) {
          const iv = base64ToBytes(chunkIVs[i]);
          // Each encrypted chunk = original chunk + 16 byte GCM tag
          const encChunkSize = Math.min(CHUNK_SIZE, fileMeta.size - (i * CHUNK_SIZE)) + GCM_TAG_SIZE;
          const encChunk = encBuffer.slice(offset, offset + encChunkSize);
          offset += encChunkSize;

          try {
            const decrypted = await decryptChunk(key, encChunk, iv);
            parts.push(new Uint8Array(decrypted));
          } catch {
            toast.error('Decryption failed — wrong password?');
            return;
          }
        }

        const decryptedBlob = new Blob(parts, { type: file.mimeType });
        const url = URL.createObjectURL(decryptedBlob);
        const a = document.createElement('a');
        a.href = url; a.download = file.filename || file.originalName; a.click();
        URL.revokeObjectURL(url);
        toast.success('File decrypted and downloaded!');
        return;
      }

      // Normal (unencrypted) download
      const { data } = await filesAPI.download(file._id);
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = file.filename || file.originalName; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Download failed.'); }
  };

  const handleDelete = async (item, type) => {
    setContextMenu(null);
    try {
      if (type === 'folder') {
        await foldersAPI.delete(item._id);
        toast.success('Folder moved to trash.');
      } else {
        await filesAPI.delete(item._id);
        toast.success('File moved to trash.');
      }
      loadFolder();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Delete failed.');
    }
  };

  const handleRename = async (newName) => {
    if (!renameModal) return;
    try {
      if (renameModal.type === 'folder') {
        await foldersAPI.update(renameModal.item._id, { name: newName });
      } else {
        await filesAPI.update(renameModal.item._id, { filename: newName });
      }
      toast.success('Renamed.');
      loadFolder();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Rename failed.');
    }
    setRenameModal(null);
  };

  const handleCreateFolder = async (name) => {
    try {
      await foldersAPI.create({
        name,
        parentFolderId: folderId === 'root' ? null : folderId,
      });
      toast.success(`Folder "${name}" created.`);
      loadFolder();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Failed to create folder.');
    }
    setNewFolderModal(false);
  };

  const handleShare = (fileId) => {
    setContextMenu(null);
    setShareModal({ fileId });
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Link copied!');
  };

  // ── Render ─────────────────────────────────────────────────
  if (loading && !folderData) {
    return <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>;
  }

  const { breadcrumbs = [], subfolders = [], files = [] } = folderData || {};
  const hasItems = subfolders.length > 0 || files.length > 0;

  return (
    <div {...getRootProps()} style={{ flex: 1, outline: 'none', position: 'relative' }}>
      <input {...getInputProps()} />
      <style>{`
        .select-checkbox {
          position: absolute;
          top: 8px;
          left: 8px;
          opacity: 0;
          transition: opacity 0.2s;
          color: var(--text-muted);
          z-index: 10;
        }
        .file-card:hover .select-checkbox,
        .file-card.selected .select-checkbox {
          opacity: 1;
        }
        .file-card.selected .select-checkbox {
          color: var(--accent);
        }
        .file-card.selected {
          border-color: var(--accent);
          background: rgba(108, 92, 231, 0.05);
        }
      `}</style>

      {/* Drag overlay */}
      {isDragActive && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'rgba(108, 92, 231, 0.08)',
          border: '3px dashed var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{ fontSize: '1.5rem', color: 'var(--accent)', fontWeight: 600 }}>
            Drop files to upload
          </div>
        </div>
      )}

      {/* Upload progress */}
      {uploadProgress && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
          background: 'var(--bg-secondary)', border: '1px solid var(--surface-border)',
          borderRadius: 'var(--radius-lg)', padding: '16px 20px', minWidth: 280,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{ fontSize: 'var(--fs-sm)', marginBottom: 6 }}>
            Uploading: {uploadProgress.name}
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${uploadProgress.percent}%` }} />
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            {uploadProgress.percent}%
          </div>
        </div>
      )}

      {/* Breadcrumbs */}
      <div className="breadcrumbs">
        {breadcrumbs.map((b, i) => (
          <span key={b._id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && <HiOutlineChevronRight className="breadcrumb-separator" />}
            <span
              className={`breadcrumb-item ${i === breadcrumbs.length - 1 ? 'current' : ''}`}
              onClick={() => i < breadcrumbs.length - 1 && openBreadcrumb(b._id)}
            >
              {b.name}
            </span>
          </span>
        ))}
      </div>

      {/* Action bar */}
      <div className="page-header">
        <h1 className="page-title">
          {breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : 'My Drive'}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasItems && (
            <button className="btn btn-ghost" onClick={handleSelectAll}>
              Select All
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setNewFolderModal(true)}>
            <HiOutlineFolderPlus /> New Folder
          </button>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            <HiOutlineCloudArrowUp /> Upload
            <input type="file" multiple style={{ display: 'none' }}
              onChange={(e) => onDrop(Array.from(e.target.files))} />
          </label>
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }} title="Upload with encryption (Zero-Knowledge Vault)">
            <HiOutlineLockClosed /> Encrypted Upload
            <input type="file" multiple style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files);
                if (files.length > 0) {
                  setPendingChunkedFiles(prev => [
                    ...prev,
                    ...files.map(file => ({
                      file,
                      folderId: folderId !== 'root' ? folderId : undefined,
                      encrypt: true,
                    })),
                  ]);
                }
              }} />
          </label>
        </div>
      </div>

      {/* Folders */}
      {subfolders.length > 0 && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Folders
          </div>
          <div className="file-grid" style={{ marginBottom: 24 }}>
            {subfolders.map((folder) => {
              const { icon: Icon, cls } = getFileIcon(null, true);
              const isSelected = selectedItems.has(`folder:${folder._id}`);
              return (
                <div key={folder._id} className={`file-card ${isSelected ? 'selected' : ''}`}
                  onClick={(e) => toggleSelect(folder._id, 'folder', e)}
                  onDoubleClick={() => openFolder(folder._id)}
                  onContextMenu={(e) => handleContextMenu(e, folder, 'folder')}
                >
                  <div className="select-checkbox" onClick={(e) => toggleSelect(folder._id, 'folder', e)}>
                    <HiOutlineCheckCircle size={20} />
                  </div>
                  <div className={`file-card-icon ${cls}`}><Icon /></div>
                  <div className="file-card-name">{folder.name}</div>
                  <div className="file-card-meta">{formatDate(folder.createdAt)}</div>
                  <div className="file-card-actions">
                    <button className="btn btn-icon btn-ghost"
                      onClick={(e) => handleContextMenu(e, folder, 'folder')}>
                      <HiOutlineEllipsisVertical />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Files */}
      {files.length > 0 && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Files
          </div>
          <div className="file-grid">
            {files.map((file) => {
              const { icon: Icon, cls } = getFileIcon(file.mimeType);
              const isSelected = selectedItems.has(`file:${file._id}`);
              return (
                <div key={file._id} className={`file-card ${isSelected ? 'selected' : ''}`}
                  onContextMenu={(e) => handleContextMenu(e, file, 'file')}
                  onClick={(e) => toggleSelect(file._id, 'file', e)}
                  onDoubleClick={() => handleDownload(file)}
                >
                  <div className="select-checkbox" onClick={(e) => toggleSelect(file._id, 'file', e)}>
                    <HiOutlineCheckCircle size={20} />
                  </div>
                  <div className={`file-card-icon ${cls}`}><Icon /></div>
                  <div className="file-card-name">
                    {file.isEncrypted && <HiOutlineLockClosed style={{ color: '#f0a500', fontSize: 13, marginRight: 4, verticalAlign: 'text-bottom' }} />}
                    {file.filename}
                  </div>
                  <div className="file-card-meta">
                    {formatSize(file.size)} · v{file.currentVersion} · {formatDate(file.createdAt)}
                    {file.isEncrypted && <span style={{ color: '#f0a500', marginLeft: 4 }}>🔐</span>}
                  </div>
                  <div className="file-card-actions">
                    <button className="btn btn-icon btn-ghost"
                      onClick={(e) => handleContextMenu(e, file, 'file')}>
                      <HiOutlineEllipsisVertical />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Selection action bar */}
      {selectedItems.size > 0 && (
        <div className="selection-bar" style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(30, 30, 30, 0.85)', backdropFilter: 'blur(12px)',
          border: '1px solid var(--surface-border)', borderRadius: 'var(--radius-full)',
          padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 1000
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{selectedItems.size} selected</span>
          <div style={{ width: 1, height: 24, background: 'var(--surface-border)' }} />
          <button className="btn btn-danger" onClick={handleBulkDelete}>
            <HiOutlineTrash /> Delete
          </button>
          <button className="btn btn-primary" onClick={handleBulkDownload}>
            <HiOutlineArrowDownTray /> Download ZIP
          </button>
          <button className="btn btn-primary" onClick={handleBulkShare}>
            <HiOutlineShare /> Share Selected
          </button>
          <button className="btn btn-ghost" onClick={() => setSelectedItems(new Set())}>
            Deselect All
          </button>
        </div>
      )}

      {/* Empty state */}
      {subfolders.length === 0 && files.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon"><HiOutlineCloudArrowUp /></div>
          <div className="empty-state-title">No files yet</div>
          <div className="empty-state-text">
            Drag and drop files here or click "Upload"
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div ref={contextRef} className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y, position: 'fixed' }}>
          {contextMenu.type === 'file' && (
            <>
              <button className="context-menu-item" onClick={() => handleDownload(contextMenu.item)}>
                <HiOutlineArrowDownTray /> Download
              </button>
              <button className="context-menu-item" onClick={() => handleShare(contextMenu.item._id)}>
                <HiOutlineShare /> Share
              </button>
              <button className="context-menu-item" onClick={() => {
                setVersionModal(contextMenu.item);
                setContextMenu(null);
              }}>
                <HiOutlineClock /> Version History
              </button>
            </>
          )}
          <button className="context-menu-item" onClick={() => {
            setRenameModal({ item: contextMenu.item, type: contextMenu.type });
            setContextMenu(null);
          }}>
            <HiOutlinePencil /> Rename
          </button>
          <div className="context-menu-divider" />
          <button className="context-menu-item danger" onClick={() => handleDelete(contextMenu.item, contextMenu.type)}>
            <HiOutlineTrash /> Move to Trash
          </button>
        </div>
      )}

      {/* Rename modal */}
      {renameModal && <RenameModal item={renameModal.item} type={renameModal.type}
        onSave={handleRename} onClose={() => setRenameModal(null)} />}

      {/* New folder modal */}
      {newFolderModal && <NewFolderModal onSave={handleCreateFolder} onClose={() => setNewFolderModal(false)} />}

      {/* Share dialog */}
      {shareModal && (
        <ShareDialog
          fileId={shareModal.fileId}
          fileIds={shareModal.fileIds}
          folderIds={shareModal.folderIds}
          isBatch={shareModal.isBatch}
          onClose={() => setShareModal(null)}
          onCopy={copyToClipboard}
        />
      )}

      {/* Version history modal */}
      {versionModal && <VersionModal file={versionModal} onClose={() => setVersionModal(null)} onRefresh={loadFolder} />}

      {/* Chunked Upload Manager (Google Drive-style progress panel) */}
      <UploadManager
        pendingFiles={pendingChunkedFiles}
        onClearPending={() => setPendingChunkedFiles([])}
        onUploadComplete={() => {
          loadFolder();
          toast.success('Chunked upload complete!');
        }}
      />
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function ShareDialog({ fileId, fileIds, folderIds, isBatch, onClose, onCopy }) {
  const [tab, setTab] = useState('public'); // 'public' | 'private'
  const [shareUrl, setShareUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState('DOWNLOAD');
  const [expiresIn, setExpiresIn] = useState('');
  const [password, setPassword] = useState('');
  const [existingShares, setExistingShares] = useState([]);
  // Private sharing
  const [emails, setEmails] = useState('');
  const [privatePermission, setPrivatePermission] = useState('VIEW');
  const [privateLoading, setPrivateLoading] = useState(false);

  // Load existing shares on mount
  useEffect(() => {
    if (!isBatch) {
      sharesAPI.getForFile(fileId).then(({ data }) => {
        setExistingShares(data.data.shares || []);
      }).catch(() => {});
    }
  }, [fileId, isBatch]);

  const handleCreatePublicShare = async () => {
    setLoading(true);
    try {
      let response;
      if (isBatch) {
        const payload = { fileIds, folderIds, permission };
        if (expiresIn) payload.expiresIn = parseInt(expiresIn, 10);
        if (password) payload.password = password;
        response = await sharesAPI.createBatch(payload);
      } else {
        const payload = { fileId, permission };
        if (expiresIn) payload.expiresIn = parseInt(expiresIn, 10);
        if (password) payload.password = password;
        response = await sharesAPI.create(payload);
      }
      const { data } = response;
      const token = data.data?.token || data.data?.share?.token;
      const url = `${window.location.origin}/shared/${token}`;
      setShareUrl(url);
      if (data.data?.share) {
        setExistingShares((prev) => [data.data.share, ...prev]);
      }
      toast.success(isBatch ? 'Multi-file share link created!' : 'Share link created!');
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Failed to create share.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePrivateShare = async () => {
    const emailList = emails.split(',').map((e) => e.trim()).filter(Boolean);
    if (emailList.length === 0) {
      toast.error('Enter at least one email address.');
      return;
    }
    setPrivateLoading(true);
    try {
      let data;
      if (isBatch) {
        const response = await sharesAPI.createBatchPrivate({
          fileIds,
          folderIds,
          users: emailList.map((email) => ({ email, permission: privatePermission })),
        });
        data = response.data;
      } else {
        const response = await sharesAPI.createPrivate({
          fileId,
          resourceType: 'file',
          users: emailList.map((email) => ({ email, permission: privatePermission })),
        });
        data = response.data;
      }
      const result = data.data;
      if (result.notFoundEmails?.length > 0) {
        toast(`Shared with ${result.sharedWithCount} user(s). Not found: ${result.notFoundEmails.join(', ')}`, { icon: '⚠️' });
      } else {
        toast.success(`Shared privately with ${result.sharedWithCount} user(s)!`);
      }
      setEmails('');
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Private share failed.');
    } finally {
      setPrivateLoading(false);
    }
  };

  const handleRevokeShare = async (shareId) => {
    try {
      await sharesAPI.revoke(shareId);
      setExistingShares((prev) => prev.filter((s) => s._id !== shareId));
      toast.success('Share link revoked.');
    } catch {
      toast.error('Failed to revoke share.');
    }
  };

  const tabStyle = (active) => ({
    padding: '8px 16px',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
    fontSize: 'var(--fs-sm)',
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2 className="modal-title">
          <HiOutlineShare style={{ marginRight: 8 }} />
          {isBatch ? `Share ${fileIds?.length || 0} Selected Item(s)` : 'Share File'}
        </h2>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--surface-border)', marginBottom: 16 }}>
          <button style={tabStyle(tab === 'public')} onClick={() => setTab('public')}>
            <HiOutlineGlobeAlt style={{ marginRight: 4, verticalAlign: 'middle' }} /> Public Link
          </button>
          <button style={tabStyle(tab === 'private')} onClick={() => setTab('private')}>
            <HiOutlineUserPlus style={{ marginRight: 4, verticalAlign: 'middle' }} /> Private Share
          </button>
        </div>

        {tab === 'public' && (
          <>
            {/* Create new public link */}
            <div className="form-group">
              <label className="form-label">Permission</label>
              <select className="form-input" value={permission} onChange={(e) => setPermission(e.target.value)}>
                <option value="DOWNLOAD">Can Download</option>
                <option value="VIEW">View Only</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Expires in (seconds)</label>
                <input className="form-input" type="number" placeholder="Never"
                  value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Password (optional)</label>
                <input className="form-input" type="text" placeholder="No password"
                  value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>

            {!shareUrl ? (
              <button className="btn btn-primary" style={{ width: '100%', marginBottom: 16 }}
                onClick={handleCreatePublicShare} disabled={loading}>
                {loading ? 'Creating...' : isBatch ? 'Generate Single Share Link' : 'Generate Share Link'}
              </button>
            ) : (
              <div className="form-group">
                <label className="form-label">{isBatch ? 'Multi-File Share Link (1 link for all items)' : 'Share URL'}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-input" value={shareUrl} readOnly />
                  <button className="btn btn-primary" onClick={() => onCopy(shareUrl)}>Copy</button>
                </div>
              </div>
            )}

            {/* Existing shares */}
            {existingShares.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>
                  Active Links ({existingShares.filter((s) => !s.isRevoked).length})
                </label>
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {existingShares.filter((s) => !s.isRevoked).map((share) => (
                    <div key={share._id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 8px', fontSize: 'var(--fs-xs)',
                      borderBottom: '1px solid var(--surface-border)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {share.isPasswordProtected && <HiOutlineLockClosed style={{ color: 'var(--warning)' }} />}
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {share.permission} · {share.downloadCount || 0} downloads
                        </span>
                      </div>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                        onClick={() => handleRevokeShare(share._id)} title="Revoke">
                        <HiOutlineXMark />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'private' && (
          <>
            <div className="form-group">
              <label className="form-label">Email addresses (comma-separated)</label>
              <input className="form-input" placeholder="user@example.com, another@example.com"
                value={emails} onChange={(e) => setEmails(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Permission</label>
              <select className="form-input" value={privatePermission}
                onChange={(e) => setPrivatePermission(e.target.value)}>
                <option value="VIEW">View Only</option>
                <option value="DOWNLOAD">Can Download</option>
              </select>
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }}
              onClick={handleCreatePrivateShare} disabled={privateLoading || !emails.trim()}>
              <HiOutlineUserPlus style={{ marginRight: 6 }} />
              {privateLoading ? 'Sharing...' : 'Share Privately'}
            </button>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 8 }}>
              Recipients will see this file in their "Shared with me" page. Only registered users can be added.
            </p>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}


function RenameModal({ item, type, onSave, onClose }) {
  const [name, setName] = useState(type === 'folder' ? item.name : item.filename);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Rename {type}</h2>
        <div className="form-group">
          <label className="form-label">New name</label>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)}
            autoFocus onKeyDown={(e) => e.key === 'Enter' && onSave(name)} />
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave(name)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function NewFolderModal({ onSave, onClose }) {
  const [name, setName] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">New Folder</h2>
        <div className="form-group">
          <label className="form-label">Folder name</label>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Untitled Folder" autoFocus
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())} />
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function VersionModal({ file, onClose, onRefresh }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    filesAPI.listVersions(file._id).then(({ data }) => {
      setVersions(data.data.versions);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [file._id]);

  const handleRestore = async (vNum) => {
    try {
      await filesAPI.restoreVersion(file._id, vNum);
      toast.success(`Restored to version ${vNum}.`);
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Restore failed.');
    }
  };

  const handleDownloadVersion = async (vNum) => {
    try {
      const { data } = await filesAPI.downloadVersion(file._id, vNum);
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = file.filename; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Download failed.'); }
  };

  const handleUploadVersion = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const formData = new FormData();
    formData.append('file', f);
    try {
      await filesAPI.uploadVersion(file._id, formData);
      toast.success('New version uploaded.');
      // Reload versions
      const { data } = await filesAPI.listVersions(file._id);
      setVersions(data.data.versions);
      onRefresh();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Upload failed.');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><HiOutlineClock style={{ marginRight: 8 }} />Version History</span>
          <label className="btn btn-sm btn-primary" style={{ cursor: 'pointer' }}>
            Upload New Version
            <input type="file" style={{ display: 'none' }} onChange={handleUploadVersion} />
          </label>
        </h2>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><div className="spinner" /></div>
        ) : (
          <div className="version-list">
            {versions.map((v) => (
              <div key={v.versionNumber} className={`version-item ${v.isCurrentVersion ? 'current' : ''}`}>
                <div className="version-info">
                  <span className="version-number">
                    Version {v.versionNumber}
                    {v.isCurrentVersion && <span className="badge badge-success" style={{ marginLeft: 8 }}>Current</span>}
                  </span>
                  <span className="version-meta">
                    {formatSize(v.size)} · {formatDate(v.createdAt)}
                    {v.changeNote && ` · ${v.changeNote}`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => handleDownloadVersion(v.versionNumber)}>
                    <HiOutlineArrowDownTray />
                  </button>
                  {!v.isCurrentVersion && (
                    <button className="btn btn-sm btn-secondary" onClick={() => handleRestore(v.versionNumber)}>
                      Restore
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
