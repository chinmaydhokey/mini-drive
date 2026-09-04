import { useState, useCallback, useRef } from 'react';
import {
  HiOutlineCloudArrowUp, HiOutlinePause, HiOutlinePlay,
  HiOutlineXMark, HiOutlineChevronUp, HiOutlineChevronDown,
  HiOutlineLockClosed, HiOutlineCheck, HiOutlineExclamationTriangle,
  HiOutlineArrowPath,
} from 'react-icons/hi2';
import { ChunkedUploader } from '../services/uploadEngine';
import { generateSalt, deriveKey, bytesToBase64 } from '../services/cryptoEngine';

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  return formatSize(bytesPerSec) + '/s';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '--';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * UploadManager — Google Drive-style persistent upload panel.
 * Renders at the bottom-right of the dashboard.
 *
 * @param {Object} props
 * @param {Array<{ file: File, folderId?: string }>} props.pendingFiles - Files queued for upload
 * @param {function} props.onClearPending - Callback to clear pending files after they're picked up
 * @param {function} props.onUploadComplete - Callback when any upload finishes
 */
export default function UploadManager({ pendingFiles = [], onClearPending, onUploadComplete }) {
  const [uploads, setUploads] = useState([]); // Array of { id, progress, uploader }
  const [isMinimized, setIsMinimized] = useState(false);
  const [encryptModal, setEncryptModal] = useState(null); // { file, folderId, resolve }
  const uploaderRefs = useRef(new Map()); // id -> ChunkedUploader
  const processedRef = useRef(new Set()); // track already-processed files

  // Pick up pending files and start uploads
  const processPending = useCallback(async () => {
    if (pendingFiles.length === 0) return;

    const newUploads = [];
    for (const { file, folderId, encrypt } of pendingFiles) {
      // Deduplicate based on file reference
      const fileKey = `${file.name}_${file.size}_${file.lastModified}`;
      if (processedRef.current.has(fileKey)) continue;
      processedRef.current.add(fileKey);

      const uploadId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      let encryptionKey = null;
      let encryptionSalt = null;

      if (encrypt) {
        // We'll need the password from the user
        const password = await new Promise((resolve) => {
          setEncryptModal({ file, folderId, resolve });
        });
        setEncryptModal(null);

        if (!password) continue; // User cancelled

        encryptionSalt = generateSalt();
        encryptionKey = await deriveKey(password, encryptionSalt);
      }

      const uploader = new ChunkedUploader(file, {
        folderId,
        encrypt: !!encrypt,
        encryptionKey,
        encryptionSalt,
        onProgress: (progress) => {
          setUploads(prev =>
            prev.map(u => u.id === uploadId ? { ...u, progress } : u)
          );
        },
        onComplete: (result) => {
          onUploadComplete?.(result);
        },
        onError: (err) => {
          console.error(`Upload failed for ${file.name}:`, err);
        },
      });

      uploaderRefs.current.set(uploadId, uploader);

      newUploads.push({
        id: uploadId,
        progress: {
          fileId: null,
          filename: file.name,
          totalChunks: uploader.totalChunks,
          uploadedChunks: 0,
          bytesUploaded: 0,
          bytesTotal: file.size,
          speed: 0,
          eta: 0,
          dedupedChunks: 0,
          dedupedBytes: 0,
          status: 'idle',
          error: null,
          isEncrypted: !!encrypt,
        },
      });

      // Start upload (async, don't await)
      uploader.start();
    }

    if (newUploads.length > 0) {
      setUploads(prev => [...prev, ...newUploads]);
      setIsMinimized(false);
    }

    onClearPending?.();
  }, [pendingFiles, onClearPending, onUploadComplete]);

  // Process pending files when they change
  useState(() => {
    processPending();
  });

  // Re-process when pendingFiles changes
  if (pendingFiles.length > 0) {
    processPending();
  }

  const handlePause = (uploadId) => {
    uploaderRefs.current.get(uploadId)?.pause();
  };

  const handleResume = (uploadId) => {
    uploaderRefs.current.get(uploadId)?.resume();
  };

  const handleCancel = (uploadId) => {
    uploaderRefs.current.get(uploadId)?.cancel();
  };

  const handleRetry = (uploadId) => {
    uploaderRefs.current.get(uploadId)?.resume();
  };

  const handleDismiss = (uploadId) => {
    uploaderRefs.current.get(uploadId)?.cancel();
    uploaderRefs.current.delete(uploadId);
    setUploads(prev => prev.filter(u => u.id !== uploadId));
  };

  const handleClearCompleted = () => {
    const completed = uploads.filter(u =>
      u.progress.status === 'complete' || u.progress.status === 'cancelled'
    );
    for (const u of completed) {
      uploaderRefs.current.delete(u.id);
    }
    setUploads(prev => prev.filter(u =>
      u.progress.status !== 'complete' && u.progress.status !== 'cancelled'
    ));
  };

  if (uploads.length === 0 && !encryptModal) return null;

  const activeCount = uploads.filter(u =>
    !['complete', 'cancelled', 'error'].includes(u.progress.status)
  ).length;
  const completeCount = uploads.filter(u => u.progress.status === 'complete').length;

  const statusColor = (status) => {
    switch (status) {
      case 'uploading': case 'hashing': case 'completing': return '#6c8aff';
      case 'paused': return '#f0a500';
      case 'complete': return '#00d68f';
      case 'error': return '#ff3d71';
      case 'cancelled': return '#888';
      default: return '#aaa';
    }
  };

  return (
    <>
      {/* Encryption Password Modal */}
      {encryptModal && (
        <div className="modal-overlay" onClick={() => { encryptModal.resolve(null); setEncryptModal(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h3><HiOutlineLockClosed style={{ marginRight: 8 }} /> Vault Password</h3>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const pw = e.target.elements.vaultPassword.value;
              if (pw) encryptModal.resolve(pw);
            }}>
              <p style={{ color: '#a0a4b8', fontSize: '0.85rem', margin: '0 0 12px' }}>
                Enter a password to encrypt <strong>{encryptModal.file.name}</strong>.
                <br />This password is <strong>never sent to the server</strong>. You'll need it to decrypt the file later.
              </p>
              <input
                name="vaultPassword"
                type="password"
                placeholder="Enter vault password..."
                autoFocus
                required
                minLength={6}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8,
                  background: '#151726', border: '1px solid #2a2e45',
                  color: '#e8eaf0', fontSize: '0.95rem', marginBottom: 12,
                }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => { encryptModal.resolve(null); setEncryptModal(null); }}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  <HiOutlineLockClosed /> Encrypt & Upload
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload Panel */}
      <div style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 380,
        maxHeight: isMinimized ? 48 : 400,
        background: '#1a1d2e',
        border: '1px solid #2a2e45',
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'max-height 0.3s ease',
      }}>
        {/* Header */}
        <div
          onClick={() => setIsMinimized(!isMinimized)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: '#1e2030',
            borderBottom: isMinimized ? 'none' : '1px solid #2a2e45',
            cursor: 'pointer',
            userSelect: 'none',
            minHeight: 46,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HiOutlineCloudArrowUp style={{ color: '#6c8aff', fontSize: 18 }} />
            <span style={{ color: '#e8eaf0', fontSize: '0.85rem', fontWeight: 600 }}>
              {activeCount > 0
                ? `Uploading ${activeCount} file${activeCount > 1 ? 's' : ''}`
                : completeCount > 0
                  ? `${completeCount} upload${completeCount > 1 ? 's' : ''} complete`
                  : 'Uploads'
              }
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {completeCount > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); handleClearCompleted(); }}
                style={{
                  background: 'none', border: 'none', color: '#6c8aff',
                  fontSize: '0.75rem', cursor: 'pointer', padding: '2px 6px',
                }}
              >
                Clear
              </button>
            )}
            {isMinimized ? <HiOutlineChevronUp style={{ color: '#a0a4b8' }} /> : <HiOutlineChevronDown style={{ color: '#a0a4b8' }} />}
          </div>
        </div>

        {/* Upload List */}
        {!isMinimized && (
          <div style={{ overflow: 'auto', flex: 1, padding: '4px 0' }}>
            {uploads.map(({ id, progress }) => (
              <div key={id} style={{
                padding: '10px 14px',
                borderBottom: '1px solid #22253a',
              }}>
                {/* File info row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                    {progress.isEncrypted && (
                      <HiOutlineLockClosed style={{ color: '#f0a500', fontSize: 14, flexShrink: 0 }} />
                    )}
                    <span style={{
                      color: '#e8eaf0', fontSize: '0.82rem', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {progress.filename}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {progress.status === 'uploading' && (
                      <button onClick={() => handlePause(id)} title="Pause"
                        style={{ background: 'none', border: 'none', color: '#a0a4b8', cursor: 'pointer', padding: 2 }}>
                        <HiOutlinePause style={{ fontSize: 16 }} />
                      </button>
                    )}
                    {progress.status === 'paused' && (
                      <button onClick={() => handleResume(id)} title="Resume"
                        style={{ background: 'none', border: 'none', color: '#6c8aff', cursor: 'pointer', padding: 2 }}>
                        <HiOutlinePlay style={{ fontSize: 16 }} />
                      </button>
                    )}
                    {progress.status === 'error' && (
                      <button onClick={() => handleRetry(id)} title="Retry"
                        style={{ background: 'none', border: 'none', color: '#f0a500', cursor: 'pointer', padding: 2 }}>
                        <HiOutlineArrowPath style={{ fontSize: 16 }} />
                      </button>
                    )}
                    {progress.status === 'complete' && (
                      <HiOutlineCheck style={{ color: '#00d68f', fontSize: 16 }} />
                    )}
                    {!['complete', 'cancelled'].includes(progress.status) && (
                      <button onClick={() => handleCancel(id)} title="Cancel"
                        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 2 }}>
                        <HiOutlineXMark style={{ fontSize: 16 }} />
                      </button>
                    )}
                    {['complete', 'cancelled'].includes(progress.status) && (
                      <button onClick={() => handleDismiss(id)} title="Dismiss"
                        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 2 }}>
                        <HiOutlineXMark style={{ fontSize: 14 }} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                <div style={{
                  width: '100%', height: 4, background: '#22253a',
                  borderRadius: 2, overflow: 'hidden', marginBottom: 4,
                }}>
                  <div style={{
                    height: '100%',
                    width: `${progress.bytesTotal > 0 ? (progress.bytesUploaded / progress.bytesTotal) * 100 : 0}%`,
                    background: statusColor(progress.status),
                    borderRadius: 2,
                    transition: 'width 0.3s ease',
                  }} />
                </div>

                {/* Stats row */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '0.72rem', color: '#888',
                }}>
                  <span>
                    {progress.status === 'complete'
                      ? formatSize(progress.bytesTotal)
                      : progress.status === 'error'
                        ? <span style={{ color: '#ff3d71' }}>{progress.error}</span>
                        : progress.status === 'hashing'
                          ? 'Computing checksums...'
                          : progress.status === 'completing'
                            ? 'Finalizing...'
                            : `${formatSize(progress.bytesUploaded)} / ${formatSize(progress.bytesTotal)}`
                    }
                  </span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {progress.status === 'uploading' && (
                      <>
                        <span>{formatSpeed(progress.speed)}</span>
                        <span>ETA {formatEta(progress.eta)}</span>
                      </>
                    )}
                    {progress.status === 'paused' && <span style={{ color: '#f0a500' }}>Paused</span>}
                    {progress.dedupedChunks > 0 && (
                      <span style={{ color: '#00d68f' }}>
                        {progress.dedupedChunks} deduped ({formatSize(progress.dedupedBytes)} saved)
                      </span>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
