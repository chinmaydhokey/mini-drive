import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import api, { sharesAPI } from '../services/api';
import FileViewerModal from '../components/FileViewerModal';
import { decryptFileBuffer } from '../services/cryptoEngine';
import { createZip } from '../utils/zipBuilder';
import {
  HiOutlineDocument, HiOutlineArrowDownTray, HiOutlineLockClosed,
  HiOutlineExclamationTriangle, HiOutlineShare, HiOutlineEye,
  HiOutlineFolder, HiOutlineArchiveBox, HiOutlinePhoto, HiOutlineFilm,
  HiOutlineMusicalNote, HiOutlineCodeBracket, HiOutlineDocumentText,
  HiOutlineXMark, HiOutlineArrowsPointingOut,
} from 'react-icons/hi2';

function formatSize(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function getFileIcon(mimeType) {
  if (!mimeType) return HiOutlineDocument;
  if (mimeType.startsWith('image/')) return HiOutlinePhoto;
  if (mimeType.startsWith('video/')) return HiOutlineFilm;
  if (mimeType.startsWith('audio/')) return HiOutlineMusicalNote;
  if (mimeType.includes('pdf')) return HiOutlineDocumentText;
  if (mimeType.startsWith('text/')) return HiOutlineDocumentText;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar'))
    return HiOutlineArchiveBox;
  if (mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml'))
    return HiOutlineCodeBracket;
  return HiOutlineDocument;
}

function InlinePreview({ file, token, password, onOpenModal }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Vault state
  const isEncrypted = Boolean(file?.isEncrypted);
  const [vaultPassword, setVaultPassword] = useState('');
  const [decrypting, setDecrypting] = useState(false);
  const [vaultError, setVaultError] = useState(null);
  const [isUnlocked, setIsUnlocked] = useState(!isEncrypted);

  const activeBlobUrlRef = useRef(null);

  const mimeType = file?.mimeType || '';
  const name = (file?.originalName || file?.filename || 'preview').replace(/\s+\./g, '.').trim();

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

  useEffect(() => {
    if (!file || isEncrypted) {
      if (isEncrypted) setLoading(false);
      return;
    }

    let active = true;
    setError(null);
    setLoading(true);

    const viewUrl = sharesAPI.viewUrl(token, password || undefined);
    const requestUrl = cleanRequestUrl(viewUrl);

    api.get(requestUrl, { responseType: 'blob' })
      .then((res) => {
        if (!active) return;
        const blob = new Blob([res.data], { type: mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        if (activeBlobUrlRef.current) URL.revokeObjectURL(activeBlobUrlRef.current);
        activeBlobUrlRef.current = url;
        setBlobUrl(url);
      })
      .catch((err) => {
        if (active) {
          const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message || 'Failed to load preview.';
          setError(typeof msg === 'string' ? msg : 'Failed to load preview.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (activeBlobUrlRef.current) {
        URL.revokeObjectURL(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
    };
  }, [file, token, password, isEncrypted, mimeType]);

  const handleUnlockVault = async (e) => {
    if (e) e.preventDefault();
    if (!vaultPassword) return;

    setDecrypting(true);
    setVaultError(null);

    try {
      const viewUrl = sharesAPI.viewUrl(token, password || undefined);
      const requestUrl = cleanRequestUrl(viewUrl);
      const res = await api.get(requestUrl, { responseType: 'arraybuffer' });
      const encBuffer = res.data;

      const decBlob = await decryptFileBuffer(encBuffer, file, vaultPassword);
      const url = URL.createObjectURL(decBlob);
      if (activeBlobUrlRef.current) URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = url;

      setBlobUrl(url);
      setIsUnlocked(true);
    } catch (err) {
      console.error('Vault decryption error:', err);
      setVaultError('Decryption failed. Please check your vault password.');
    } finally {
      setDecrypting(false);
    }
  };

  if (!file) return null;

  if (isEncrypted && !isUnlocked) {
    return (
      <div className="shared-vault-card" style={{
        background: 'rgba(240, 165, 0, 0.05)',
        border: '1px solid rgba(240, 165, 0, 0.25)',
        borderRadius: 14,
        padding: '28px 24px',
        marginTop: 16,
        textAlign: 'center'
      }}>
        <div style={{
          width: 54, height: 54, borderRadius: 14,
          background: 'rgba(240, 165, 0, 0.12)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 14, color: '#f0a500', fontSize: 28
        }}>
          <HiOutlineLockClosed />
        </div>
        <h3 style={{ color: '#f0a500', margin: '0 0 8px', fontSize: '1.15rem', fontWeight: 600 }}>
          Zero-Knowledge Encrypted Document
        </h3>
        <p style={{ color: '#c4c6d4', fontSize: '0.875rem', margin: '0 0 18px', maxWidth: 420, marginInline: 'auto' }}>
          This file is encrypted client-side with AES-256-GCM. MiniDrive servers do not hold the decryption key. Enter your vault password to decrypt and preview this document.
        </p>
        <form onSubmit={handleUnlockVault} style={{ display: 'flex', gap: 10, justifyContent: 'center', maxWidth: 360, margin: '0 auto' }}>
          <input
            type="password"
            className="form-input"
            placeholder="Enter vault password"
            value={vaultPassword}
            onChange={(e) => setVaultPassword(e.target.value)}
            disabled={decrypting}
            style={{ flex: 1 }}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={decrypting || !vaultPassword}
            style={{ background: '#f0a500', borderColor: '#f0a500', color: '#000', fontWeight: 600 }}
          >
            {decrypting ? 'Decrypting...' : 'Unlock & View'}
          </button>
        </form>
        {vaultError && (
          <p style={{ color: '#ff4d4f', fontSize: '0.85rem', marginTop: 12, marginBottom: 0 }}>
            {vaultError}
          </p>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: '36px 0', textAlign: 'center', color: '#8b8ea8' }}>
        <div className="spinner" style={{ width: 28, height: 28, margin: '0 auto 12px' }} />
        <p style={{ fontSize: '0.875rem' }}>Loading document preview...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: '#ff3d71', background: 'rgba(255, 61, 113, 0.08)', borderRadius: 12, marginTop: 12 }}>
        <p style={{ margin: 0, fontSize: '0.9rem' }}>{error}</p>
      </div>
    );
  }

  if (!blobUrl) return null;

  return (
    <div style={{ marginTop: 12 }}>
      {onOpenModal && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button
            className="btn btn-sm btn-secondary"
            onClick={onOpenModal}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}
          >
            <HiOutlineArrowsPointingOut /> Full Screen
          </button>
        </div>
      )}

      {mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf') ? (
        <iframe
          src={`${blobUrl}#toolbar=0`}
          title={name}
          style={{ width: '100%', height: 600, border: 'none', borderRadius: 8, background: '#fff' }}
        />
      ) : mimeType.startsWith('image/') ? (
        <img
          src={blobUrl}
          alt={name}
          style={{ maxWidth: '100%', maxHeight: 500, borderRadius: 8, objectFit: 'contain' }}
        />
      ) : mimeType.startsWith('video/') ? (
        <video
          controls
          controlsList="nodownload"
          src={blobUrl}
          style={{ maxWidth: '100%', maxHeight: 450, borderRadius: 8 }}
        />
      ) : mimeType.startsWith('audio/') ? (
        <audio
          controls
          controlsList="nodownload"
          src={blobUrl}
          style={{ width: '100%' }}
        />
      ) : (
        <iframe
          src={blobUrl}
          title={name}
          style={{ width: '100%', height: 400, border: '1px solid #2a2e45', borderRadius: 8, background: '#1a1b2e', color: '#e8eaf0' }}
        />
      )}
    </div>
  );
}

export default function SharedFile() {
  const { token } = useParams();
  const [shareData, setShareData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadingFileId, setDownloadingFileId] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);

  const loadShare = async (pwd) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await sharesAPI.access(token, pwd || undefined);
      setShareData(data.data);
      setNeedsPassword(false);
    } catch (err) {
      const resp = err.response?.data;
      if (resp?.error?.passwordRequired) {
        setNeedsPassword(true);
      } else {
        setError(resp?.error?.message || resp?.error || 'This share link is invalid or has expired.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadShare(); }, [token]);

  // Download entire bundle as ZIP or single file
  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      // ── SINGLE FILE DOWNLOAD ──
      if (!isBatch && singleFile) {
        if (singleFile.isEncrypted) {
          const vaultPwd = prompt('🔐 This file is encrypted in the Vault.\nEnter your vault password to decrypt it:');
          if (!vaultPwd) {
            setDownloadingAll(false);
            return;
          }
          const { data: encBlob } = await sharesAPI.download(token, password || undefined);
          const encBuffer = await encBlob.arrayBuffer();
          const decryptedBlob = await decryptFileBuffer(encBuffer, singleFile, vaultPwd);
          const url = window.URL.createObjectURL(decryptedBlob);
          const a = document.createElement('a');
          a.href = url;
          const cleanName = (singleFile.originalName || singleFile.filename || 'download').replace(/\s+\./g, '.').trim();
          a.download = cleanName;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            window.URL.revokeObjectURL(url);
            a.remove();
          }, 60000);
          return;
        }

        const { data } = await sharesAPI.download(token, password || undefined);
        const url = window.URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        const cleanName = (singleFile.originalName || singleFile.filename || 'download').replace(/\s+\./g, '.').trim();
        a.download = cleanName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          window.URL.revokeObjectURL(url);
          a.remove();
        }, 60000);
        return;
      }

      // ── BATCH / COLLECTION ZIP DOWNLOAD ──
      if (isBatch) {
        const hasEncrypted = filesList.some(f => Boolean(f.isEncrypted));

        if (hasEncrypted) {
          const vaultPwd = prompt('🔐 One or more shared files are encrypted in the Vault.\nEnter your vault password to decrypt them:');
          if (!vaultPwd) {
            setDownloadingAll(false);
            return;
          }

          const zipEntries = [];
          const usedNames = {};

          for (const f of filesList) {
            let rawName = (f.originalName || f.filename || 'download').replace(/\s+\./g, '.').trim();
            let name = rawName;
            if (usedNames[rawName]) {
              const ext = rawName.lastIndexOf('.') !== -1 ? rawName.slice(rawName.lastIndexOf('.')) : '';
              const base = rawName.lastIndexOf('.') !== -1 ? rawName.slice(0, rawName.lastIndexOf('.')) : rawName;
              name = `${base} (${usedNames[rawName]})${ext}`;
            }
            usedNames[rawName] = (usedNames[rawName] || 0) + 1;

            if (f.isEncrypted) {
              const { data: encBlob } = await sharesAPI.downloadBatchFile(token, f._id, password || undefined);
              const encBuffer = await encBlob.arrayBuffer();
              const decBlob = await decryptFileBuffer(encBuffer, f, vaultPwd);
              const decBuffer = await decBlob.arrayBuffer();
              zipEntries.push({ name, data: new Uint8Array(decBuffer) });
            } else {
              const { data: fileBlob } = await sharesAPI.downloadBatchFile(token, f._id, password || undefined);
              const buffer = await fileBlob.arrayBuffer();
              zipEntries.push({ name, data: new Uint8Array(buffer) });
            }
          }

          const zipBlob = createZip(zipEntries);
          const url = window.URL.createObjectURL(zipBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `MiniDrive_Shared_${filesList.length}_files.zip`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            window.URL.revokeObjectURL(url);
            a.remove();
          }, 60000);
          return;
        }

        const { data } = await sharesAPI.download(token, password || undefined);
        const url = window.URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        const downloadName = `MiniDrive_Shared_${filesList.length}_files.zip`;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          window.URL.revokeObjectURL(url);
          a.remove();
        }, 60000);
      }
    } catch (err) {
      setError(err.message || 'Download failed. The link may have expired.');
    } finally {
      setDownloadingAll(false);
    }
  };

  // Download individual file from batch
  const handleDownloadSingle = async (file) => {
    setDownloadingFileId(file._id);
    try {
      if (file.isEncrypted) {
        const vaultPwd = prompt('Enter vault password to decrypt this file:');
        if (!vaultPwd) {
          setDownloadingFileId(null);
          return;
        }
        const { decryptFileBuffer } = await import('../services/cryptoEngine');
        const { data: encBlob } = await sharesAPI.downloadBatchFile(token, file._id, password || undefined);
        const encBuffer = await encBlob.arrayBuffer();
        const decryptedBlob = await decryptFileBuffer(encBuffer, file, vaultPwd);
        const url = window.URL.createObjectURL(decryptedBlob);
        const a = document.createElement('a');
        a.href = url;
        const cleanName = (file.originalName || file.filename || 'download').replace(/\s+\./g, '.').trim();
        a.download = cleanName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          window.URL.revokeObjectURL(url);
          a.remove();
        }, 60000);
        return;
      }

      const { data } = await sharesAPI.downloadBatchFile(token, file._id, password || undefined);
      const url = window.URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      const cleanName = (file.originalName || file.filename || 'download').replace(/\s+\./g, '.').trim();
      a.download = cleanName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        a.remove();
      }, 60000);
    } catch (err) {
      setError(err.message || 'Download failed for this file.');
    } finally {
      setDownloadingFileId(null);
    }
  };

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    loadShare(password);
  };

  const isBatch = shareData?.resourceType === 'batch' || shareData?.resourceType === 'folder' || (shareData?.files && shareData.files.length > 0);
  const permission = shareData?.permission || 'DOWNLOAD';
  const singleFile = shareData?.file;
  const filesList = shareData?.files || [];

  return (
    <div className="shared-page">
      <div className="shared-card" style={{ maxWidth: isBatch ? 760 : 560 }}>
        <div className="shared-header">
          <div className="shared-icon-badge">
            {isBatch ? <HiOutlineArchiveBox className="shared-icon" /> : <HiOutlineShare className="shared-icon" />}
          </div>
          <h1>{isBatch ? 'Shared Collection' : 'Shared File'}</h1>
          <p className="shared-sub">
            {isBatch
              ? `${filesList.length} item(s) shared via single link (${formatSize(shareData?.totalSize)})`
              : 'Someone shared a file with you via MiniDrive'}
          </p>
        </div>

        {loading && (
          <div className="shared-loading">
            <div className="spinner" style={{ width: 32, height: 32 }} />
            <p>Loading shared content...</p>
          </div>
        )}

        {error && (
          <div className="shared-error">
            <HiOutlineExclamationTriangle style={{ fontSize: 40, color: '#ff3d71' }} />
            <p>{error}</p>
          </div>
        )}

        {needsPassword && !loading && (
          <form className="shared-password" onSubmit={handlePasswordSubmit}>
            <HiOutlineLockClosed style={{ fontSize: 40, color: '#a78bfa' }} />
            <p>This shared link is password protected</p>
            <input
              className="form-input"
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button className="btn btn-primary" type="submit">Unlock Collection</button>
          </form>
        )}

        {/* ── Single File View ── */}
        {!isBatch && singleFile && !loading && (
          <div className="shared-content">
            <div className="shared-file-info">
              <HiOutlineDocument style={{ fontSize: 44, color: '#6366f1' }} />
              <div>
                <h2 className="shared-filename">{singleFile.originalName || singleFile.filename}</h2>
                <p className="shared-meta">{formatSize(singleFile.size)} · {singleFile.mimeType}</p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button
                className="btn btn-secondary btn-lg"
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={() => setPreviewFile(singleFile)}
              >
                <HiOutlineEye /> Preview
              </button>

              {permission === 'DOWNLOAD' && (
                <button
                  className="btn btn-primary btn-lg shared-download-btn"
                  style={{ flex: 2 }}
                  onClick={handleDownloadAll}
                  disabled={downloadingAll}
                >
                  {downloadingAll ? (
                    <><div className="spinner" style={{ width: 18, height: 18 }} /> Downloading...</>
                  ) : (
                    <><HiOutlineArrowDownTray /> Download File</>
                  )}
                </button>
              )}
            </div>

            {permission === 'VIEW' && (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#a78bfa', fontSize: '0.875rem', marginBottom: 8 }}>
                  <HiOutlineEye /> View-only — downloads are not permitted
                </div>
                <InlinePreview
                  file={singleFile}
                  token={token}
                  password={password}
                  onOpenModal={() => setPreviewFile(singleFile)}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Multi-File / Batch View ── */}
        {isBatch && !loading && (
          <div className="shared-content">
            {/* Hero Action Bar */}
            {permission === 'DOWNLOAD' && (
              <div style={{ marginBottom: 20 }}>
                <button
                  className="btn btn-primary btn-lg shared-download-btn"
                  onClick={handleDownloadAll}
                  disabled={downloadingAll}
                >
                  {downloadingAll ? (
                    <><div className="spinner" style={{ width: 18, height: 18 }} /> Preparing ZIP Archive...</>
                  ) : (
                    <><HiOutlineArrowDownTray /> Download All as ZIP ({formatSize(shareData?.totalSize)})</>
                  )}
                </button>
              </div>
            )}

            {permission === 'VIEW' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#a78bfa', fontSize: '0.875rem', marginBottom: 16 }}>
                <HiOutlineEye /> View-only collection — select a file to preview
              </div>
            )}

            {/* Files List Table */}
            <div className="shared-files-table-container">
              <table className="shared-files-table">
                <thead>
                  <tr>
                    <th>Item Name</th>
                    <th>Size</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filesList.map((f) => {
                    const Icon = getFileIcon(f.mimeType);
                    const isDownloadingThis = downloadingFileId === f._id;
                    return (
                      <tr key={f._id} className="shared-file-row">
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <Icon style={{ fontSize: 22, color: '#818cf8', flexShrink: 0 }} />
                            <span className="shared-table-filename">{f.originalName || f.filename}</span>
                          </div>
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                          {formatSize(f.size)}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => setPreviewFile(f)}
                              title="Preview"
                            >
                              <HiOutlineEye /> Preview
                            </button>
                            {permission === 'DOWNLOAD' && (
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={() => handleDownloadSingle(f)}
                                disabled={isDownloadingThis}
                                title="Download File"
                              >
                                {isDownloadingThis ? (
                                  <div className="spinner" style={{ width: 14, height: 14 }} />
                                ) : (
                                  <HiOutlineArrowDownTray />
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Preview Modal ── */}
        {previewFile && (
          <FileViewerModal
            file={previewFile}
            permission={permission}
            viewUrl={isBatch ? sharesAPI.viewBatchFileUrl(token, previewFile._id, password || undefined) : sharesAPI.viewUrl(token, password || undefined)}
            onClose={() => setPreviewFile(null)}
            onDownload={permission === 'DOWNLOAD' ? () => (isBatch ? handleDownloadSingle(previewFile) : handleDownloadAll()) : undefined}
          />
        )}

        <div className="shared-footer">
          <a href="/" className="shared-back-link">← Go to MiniDrive</a>
        </div>
      </div>

      <style>{`
        .shared-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #0b0c1b, #15162c);
          padding: 24px 16px;
        }
        .shared-card {
          background: rgba(22, 24, 45, 0.95);
          backdrop-filter: blur(16px);
          border: 1px solid #2a2e4d;
          border-radius: 20px;
          padding: 36px;
          width: 100%;
          text-align: center;
          box-shadow: 0 24px 64px rgba(0,0,0,0.6);
        }
        .shared-header { margin-bottom: 28px; }
        .shared-icon-badge {
          width: 64px; height: 64px; border-radius: 16px;
          background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.25);
          display: inline-flex; align-items: center; justify-content: center; margin-bottom: 14px;
        }
        .shared-icon { font-size: 32px; color: #818cf8; }
        .shared-header h1 { font-size: 1.6rem; color: #f1f3f9; margin: 0 0 6px; font-weight: 700; }
        .shared-sub { color: #8b8ea8; font-size: 0.875rem; margin: 0; }
        .shared-loading { padding: 32px 0; color: #8b8ea8; }
        .shared-loading p { margin-top: 12px; }
        .shared-error { padding: 24px 0; color: #ff3d71; }
        .shared-error p { margin-top: 12px; }
        .shared-password { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px 0; }
        .shared-password p { color: #c4c6d4; margin: 0; }
        .shared-password .form-input { max-width: 280px; text-align: center; }
        .shared-content { padding: 8px 0; text-align: left; }
        .shared-file-info {
          display: flex; align-items: center; gap: 16px;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px;
          padding: 20px; margin-bottom: 24px; text-align: left;
        }
        .shared-filename { font-size: 1.1rem; color: #e8eaf0; margin: 0 0 4px; word-break: break-all; }
        .shared-meta { color: #8b8ea8; font-size: 0.8rem; margin: 0; }
        .shared-download-btn {
          width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
          padding: 14px 24px; font-size: 1rem; font-weight: 600; border-radius: 12px;
        }
        .shared-files-table-container {
          max-height: 380px; overflow-y: auto; border: 1px solid #2a2e4d; border-radius: 14px;
          background: rgba(15, 16, 32, 0.6);
        }
        .shared-files-table {
          width: 100%; border-collapse: collapse; text-align: left;
        }
        .shared-files-table th {
          padding: 12px 16px; font-size: 0.75rem; text-transform: uppercase; color: #8b8ea8;
          border-bottom: 1px solid #2a2e4d; background: rgba(20, 22, 42, 0.8); font-weight: 600;
        }
        .shared-files-table td {
          padding: 12px 16px; border-bottom: 1px solid rgba(42, 46, 77, 0.5); vertical-align: middle;
        }
        .shared-file-row:hover {
          background: rgba(99, 102, 241, 0.05);
        }
        .shared-table-filename {
          color: #e8eaf0; font-size: 0.9rem; font-weight: 500; word-break: break-all;
        }
        .shared-footer { margin-top: 28px; border-top: 1px solid #2a2e4d; padding-top: 18px; text-align: center; }
        .shared-back-link { color: #818cf8; text-decoration: none; font-size: 0.875rem; font-weight: 500; }
        .shared-back-link:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
}
