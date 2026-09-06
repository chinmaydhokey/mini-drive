import { useState, useEffect, useRef } from 'react';
import {
  HiOutlineXMark, HiOutlineArrowDownTray,
  HiOutlineMagnifyingGlassPlus, HiOutlineMagnifyingGlassMinus,
  HiOutlineArrowPath, HiOutlineLockClosed, HiOutlineDocumentText,
  HiOutlineDocument, HiOutlineKey,
} from 'react-icons/hi2';
import api from '../services/api';
import { decryptFileBuffer } from '../services/cryptoEngine';

function formatSize(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function isTextOrCode(mimeType, filename = '') {
  if (!mimeType) mimeType = '';
  if (mimeType.startsWith('text/')) return true;
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('xml')) return true;
  const ext = filename.split('.').pop()?.toLowerCase();
  return ['txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'json', 'py', 'html', 'css', 'scss', 'csv', 'sql', 'sh', 'yaml', 'yml', 'xml', 'log'].includes(ext);
}

export default function FileViewerModal({ file, permission = 'VIEW', viewUrl, onClose, onDownload }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [textContent, setTextContent] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [loadedBlob, setLoadedBlob] = useState(null);
  const [decryptedBlob, setDecryptedBlob] = useState(null);
  const [loadingContent, setLoadingContent] = useState(true);
  const [error, setError] = useState(null);

  // Vault state
  const isEncrypted = Boolean(file?.isEncrypted);
  const [vaultPassword, setVaultPassword] = useState('');
  const [decrypting, setDecrypting] = useState(false);
  const [vaultError, setVaultError] = useState(null);
  const [isUnlocked, setIsUnlocked] = useState(!isEncrypted);

  const activeBlobUrlRef = useRef(null);

  const name = (file?.originalName || file?.filename || 'File Preview').replace(/\s+\./g, '.').trim();
  const mimeType = file?.mimeType || '';
  const isViewOnly = permission === 'VIEW';

  const cleanRequestUrl = (url) => {
    if (!url) return '';
    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const u = new URL(url);
        return u.pathname.replace(/^\/api/, '') + u.search;
      }
    } catch {}
    return url.replace(/^\/api/, '');
  };

  // Load normal (unencrypted) content
  useEffect(() => {
    if (!viewUrl || isEncrypted) {
      if (isEncrypted) setLoadingContent(false);
      return;
    }

    let active = true;
    setError(null);
    setLoadingContent(true);

    const requestUrl = cleanRequestUrl(viewUrl);

    if (isTextOrCode(mimeType, name)) {
      api.get(requestUrl, { responseType: 'text' })
        .then((res) => {
          if (active) setTextContent(res.data);
        })
        .catch((err) => {
          if (active) {
            const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message || 'Failed to load text preview.';
            setError(typeof msg === 'string' ? msg : 'Failed to load text preview.');
          }
        })
        .finally(() => {
          if (active) setLoadingContent(false);
        });
    } else {
      // For PDFs, images, videos, and audio: fetch blob and construct a local blob URL
      api.get(requestUrl, { responseType: 'blob' })
        .then((res) => {
          if (!active) return;
          const blob = new Blob([res.data], { type: mimeType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          if (activeBlobUrlRef.current) URL.revokeObjectURL(activeBlobUrlRef.current);
          activeBlobUrlRef.current = url;
          setLoadedBlob(blob);
          setBlobUrl(url);
        })
        .catch((err) => {
          if (active) {
            const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message || 'Failed to load file preview.';
            setError(typeof msg === 'string' ? msg : 'Failed to load file preview.');
          }
        })
        .finally(() => {
          if (active) setLoadingContent(false);
        });
    }

    return () => {
      active = false;
      if (activeBlobUrlRef.current) {
        URL.revokeObjectURL(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
    };
  }, [viewUrl, isEncrypted, mimeType, name]);

  // Handle Vault Unlock for encrypted file
  const handleUnlockVault = async (e) => {
    if (e) e.preventDefault();
    if (!vaultPassword) return;

    setDecrypting(true);
    setVaultError(null);

    try {
      const requestUrl = cleanRequestUrl(viewUrl);
      const res = await api.get(requestUrl, { responseType: 'arraybuffer' });
      const encBuffer = res.data;

      const decBlob = await decryptFileBuffer(encBuffer, file, vaultPassword);
      const url = URL.createObjectURL(decBlob);
      if (activeBlobUrlRef.current) URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = url;

      setDecryptedBlob(decBlob);
      setBlobUrl(url);
      setIsUnlocked(true);

      if (isTextOrCode(mimeType, name)) {
        const text = await decBlob.text();
        setTextContent(text);
      }
    } catch (err) {
      console.error('Vault decryption error:', err);
      setVaultError('Decryption failed. Please check your vault password.');
    } finally {
      setDecrypting(false);
    }
  };

  // Keyboard shortcuts (Escape, Ctrl+S / Ctrl+P view-only blocker)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
      if (isViewOnly && (e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isViewOnly]);

  const handleZoomIn = () => setZoom((z) => Math.min(3, z + 0.25));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, z - 0.25));
  const handleRotate = () => setRotation((r) => (r + 90) % 360);

  const handleDownloadFile = () => {
    const targetBlob = decryptedBlob || loadedBlob;
    if (targetBlob) {
      const url = URL.createObjectURL(targetBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 60000);
      return;
    }
    if (onDownload) onDownload();
  };

  const renderContent = () => {
    // Encrypted Vault Locked State
    if (isEncrypted && !isUnlocked) {
      return (
        <div className="viewer-vault-box">
          <div className="viewer-vault-icon">
            <HiOutlineLockClosed style={{ fontSize: 44, color: '#818cf8' }} />
          </div>
          <h3 style={{ color: '#f1f3f9', margin: '0 0 6px', fontSize: '1.25rem' }}>Encrypted Vault File</h3>
          <p style={{ color: '#8b8ea8', fontSize: '0.875rem', maxWidth: 420, margin: '0 auto 20px', lineHeight: 1.5 }}>
            This file was encrypted client-side with AES-256-GCM. Enter your vault password to decrypt and view it.
          </p>

          <form onSubmit={handleUnlockVault} style={{ width: '100%', maxWidth: 360, margin: '0 auto' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="password"
                className="form-input"
                placeholder="Enter vault password"
                value={vaultPassword}
                onChange={(e) => setVaultPassword(e.target.value)}
                autoFocus
                style={{ flex: 1, padding: '10px 14px', borderRadius: 8, background: '#1a1c36', border: '1px solid #2a2e4d', color: '#fff' }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={decrypting || !vaultPassword}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 8 }}
              >
                {decrypting ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <HiOutlineKey />}
                {decrypting ? 'Decrypting...' : 'Unlock'}
              </button>
            </div>
            {vaultError && (
              <p style={{ color: '#ff3d71', fontSize: '0.85rem', margin: '4px 0 0' }}>{vaultError}</p>
            )}
          </form>
        </div>
      );
    }

    if (loadingContent) {
      return (
        <div className="viewer-loading">
          <div className="spinner" style={{ width: 36, height: 36 }} />
          <p style={{ marginTop: 14 }}>Loading preview...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="viewer-unsupported">
          <HiOutlineDocument style={{ fontSize: 64, color: '#ff3d71', marginBottom: 16 }} />
          <h3 style={{ color: '#e8eaf0', margin: '0 0 8px' }}>Preview Error</h3>
          <p style={{ color: '#ff3d71', fontSize: '0.875rem' }}>{error}</p>
        </div>
      );
    }

    const mediaSrc = blobUrl || viewUrl;

    if (mimeType.startsWith('image/')) {
      return (
        <div className="viewer-image-canvas" onContextMenu={(e) => isViewOnly && e.preventDefault()}>
          <img
            src={mediaSrc}
            alt={name}
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transition: 'transform 0.2s ease',
              maxHeight: '75vh',
              maxWidth: '100%',
              objectFit: 'contain',
              userSelect: isViewOnly ? 'none' : 'auto',
              pointerEvents: isViewOnly ? 'none' : 'auto',
            }}
          />
        </div>
      );
    }

    if (mimeType === 'application/pdf') {
      return (
        <div className="viewer-pdf-frame">
          <iframe
            src={`${mediaSrc}#toolbar=0`}
            title={name}
            style={{ width: '100%', height: '75vh', border: 'none', borderRadius: 8, background: '#fff' }}
          />
        </div>
      );
    }

    if (mimeType.startsWith('video/')) {
      return (
        <div className="viewer-media-container" onContextMenu={(e) => isViewOnly && e.preventDefault()}>
          <video
            controls
            controlsList={isViewOnly ? 'nodownload' : undefined}
            src={mediaSrc}
            style={{ maxHeight: '75vh', maxWidth: '100%', borderRadius: 8 }}
          />
        </div>
      );
    }

    if (mimeType.startsWith('audio/')) {
      return (
        <div className="viewer-audio-container" onContextMenu={(e) => isViewOnly && e.preventDefault()}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <HiOutlineDocumentText style={{ fontSize: 64, color: '#818cf8', marginBottom: 12 }} />
            <h3 style={{ margin: 0, color: '#e8eaf0' }}>{name}</h3>
            <p style={{ color: '#8b8ea8', fontSize: '0.85rem' }}>{formatSize(file?.size)}</p>
          </div>
          <audio
            controls
            controlsList={isViewOnly ? 'nodownload' : undefined}
            src={mediaSrc}
            style={{ width: '100%', maxWidth: 420 }}
          />
        </div>
      );
    }

    if (isTextOrCode(mimeType, name)) {
      if (textContent !== null) {
        const lines = textContent.split('\n');
        return (
          <div className="viewer-code-block">
            <div className="viewer-code-lines">
              {lines.map((_, i) => (
                <span key={i} className="line-num">{i + 1}</span>
              ))}
            </div>
            <pre className="viewer-code-content">{textContent}</pre>
          </div>
        );
      }

      return (
        <iframe
          src={mediaSrc}
          title={name}
          style={{ width: '100%', height: '75vh', border: '1px solid #2a2e4d', borderRadius: 8, background: '#121324', color: '#e8eaf0' }}
        />
      );
    }

    return (
      <div className="viewer-unsupported">
        <HiOutlineDocument style={{ fontSize: 64, color: '#6366f1', marginBottom: 16 }} />
        <h3 style={{ color: '#e8eaf0', margin: '0 0 8px' }}>{name}</h3>
        <p style={{ color: '#8b8ea8', fontSize: '0.875rem', margin: '0 0 16px' }}>
          {formatSize(file?.size)} · {mimeType || 'Binary Document'}
        </p>
        <p style={{ color: '#a78bfa', fontSize: '0.85rem', background: 'rgba(167, 139, 250, 0.1)', padding: '8px 16px', borderRadius: 8, display: 'inline-block' }}>
          Interactive inline preview is not available for this file type.
        </p>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 2000 }}>
      <div className="viewer-modal" onClick={(e) => e.stopPropagation()}>
        {/* Top Header */}
        <div className="viewer-header">
          <div className="viewer-title-group">
            <h2 className="viewer-filename" title={name}>{name}</h2>
            <div className="viewer-badges">
              <span className="badge badge-info">{formatSize(file?.size)}</span>
              {isEncrypted && (
                <span className="badge badge-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(99, 102, 241, 0.2)', color: '#a5b4fc', border: '1px solid rgba(99, 102, 241, 0.4)' }}>
                  🔐 Encrypted Vault
                </span>
              )}
              {isViewOnly ? (
                <span className="badge badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <HiOutlineLockClosed /> View Only
                </span>
              ) : (
                <span className="badge badge-success">Can Download</span>
              )}
            </div>
          </div>

          {/* Controls */}
          <div className="viewer-controls">
            {mimeType.startsWith('image/') && (
              <div className="viewer-image-controls">
                <button className="btn btn-sm btn-ghost" onClick={handleZoomOut} title="Zoom Out"><HiOutlineMagnifyingGlassMinus /></button>
                <span style={{ fontSize: '0.75rem', color: '#8b8ea8', minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                <button className="btn btn-sm btn-ghost" onClick={handleZoomIn} title="Zoom In"><HiOutlineMagnifyingGlassPlus /></button>
                <button className="btn btn-sm btn-ghost" onClick={handleRotate} title="Rotate 90°"><HiOutlineArrowPath /></button>
              </div>
            )}

            {!isViewOnly && (onDownload || isUnlocked) && (
              <button className="btn btn-sm btn-primary" onClick={handleDownloadFile} title="Download File">
                <HiOutlineArrowDownTray /> Download
              </button>
            )}

            <button className="btn btn-sm btn-ghost" onClick={onClose} title="Close Preview">
              <HiOutlineXMark style={{ fontSize: 20 }} />
            </button>
          </div>
        </div>

        {/* View-Only Security Notice Banner */}
        {isViewOnly && (
          <div className="viewer-notice">
            <HiOutlineLockClosed style={{ fontSize: 16, flexShrink: 0 }} />
            <span>This file is shared in <strong>View Only</strong> mode. Downloading, copying, and printing are disabled.</span>
          </div>
        )}

        {/* Viewer Body */}
        <div className="viewer-body">
          {renderContent()}
        </div>
      </div>

      <style>{`
        .viewer-modal {
          background: rgba(18, 20, 38, 0.98);
          backdrop-filter: blur(20px);
          border: 1px solid #2a2e4d;
          border-radius: 16px;
          width: 98vw;
          max-width: 1080px;
          max-height: 92vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 32px 80px rgba(0,0,0,0.7);
          overflow: hidden;
        }
        .viewer-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid #2a2e4d;
          background: rgba(24, 26, 50, 0.8);
          gap: 16px;
        }
        .viewer-title-group {
          display: flex;
          align-items: center;
          gap: 12px;
          overflow: hidden;
        }
        .viewer-filename {
          margin: 0;
          font-size: 1.05rem;
          font-weight: 600;
          color: #f1f3f9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .viewer-badges {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .viewer-controls {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }
        .viewer-image-controls {
          display: flex;
          align-items: center;
          gap: 4px;
          background: rgba(255,255,255,0.05);
          padding: 2px 6px;
          border-radius: 8px;
          border: 1px solid #2a2e4d;
        }
        .viewer-notice {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 20px;
          background: rgba(245, 158, 11, 0.12);
          border-bottom: 1px solid rgba(245, 158, 11, 0.25);
          color: #fbbf24;
          font-size: 0.8rem;
        }
        .viewer-body {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          overflow: auto;
          min-height: 400px;
          background: #0d0e1d;
        }
        .viewer-vault-box {
          text-align: center;
          padding: 40px 20px;
          background: rgba(22, 24, 48, 0.7);
          border: 1px solid #2a2e4d;
          border-radius: 16px;
          max-width: 500px;
          width: 100%;
        }
        .viewer-vault-icon {
          width: 72px;
          height: 72px;
          border-radius: 20px;
          background: rgba(99, 102, 241, 0.12);
          border: 1px solid rgba(99, 102, 241, 0.3);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 16px;
        }
        .viewer-image-canvas {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          overflow: auto;
        }
        .viewer-pdf-frame {
          width: 100%;
          height: 100%;
        }
        .viewer-media-container {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .viewer-audio-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 100%;
          padding: 40px;
        }
        .viewer-code-block {
          display: flex;
          width: 100%;
          max-height: 75vh;
          overflow: auto;
          background: #111224;
          border: 1px solid #2a2e4d;
          border-radius: 8px;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.85rem;
        }
        .viewer-code-lines {
          padding: 16px 10px;
          text-align: right;
          color: #52567a;
          background: rgba(0,0,0,0.2);
          border-right: 1px solid #2a2e4d;
          user-select: none;
          display: flex;
          flex-direction: column;
        }
        .line-num { line-height: 1.5; }
        .viewer-code-content {
          padding: 16px;
          margin: 0;
          color: #e2e8f0;
          line-height: 1.5;
          overflow-x: auto;
          white-space: pre;
          flex: 1;
        }
        .viewer-unsupported {
          text-align: center;
          padding: 40px;
        }
        .viewer-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          color: #8b8ea8;
        }
        .viewer-loading p { margin-top: 12px; }
      `}</style>
    </div>
  );
}
