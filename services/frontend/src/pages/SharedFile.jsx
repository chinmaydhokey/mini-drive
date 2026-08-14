import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { sharesAPI } from '../services/api';
import FileViewerModal from '../components/FileViewerModal';
import {
  HiOutlineDocument, HiOutlineArrowDownTray, HiOutlineLockClosed,
  HiOutlineExclamationTriangle, HiOutlineShare, HiOutlineEye,
  HiOutlineFolder, HiOutlineArchiveBox, HiOutlinePhoto, HiOutlineFilm,
  HiOutlineMusicalNote, HiOutlineCodeBracket, HiOutlineDocumentText,
  HiOutlineXMark,
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

function InlinePreview({ mimeType, viewUrl }) {
  if (!mimeType || !viewUrl) return null;

  if (mimeType.startsWith('image/')) {
    return <img src={viewUrl} alt="Shared file preview" style={{ maxWidth: '100%', maxHeight: 450, borderRadius: 8, marginTop: 12, objectFit: 'contain' }} />;
  }
  if (mimeType.startsWith('video/')) {
    return <video controls src={viewUrl} style={{ maxWidth: '100%', maxHeight: 450, borderRadius: 8, marginTop: 12 }} />;
  }
  if (mimeType.startsWith('audio/')) {
    return <audio controls src={viewUrl} style={{ width: '100%', marginTop: 12 }} />;
  }
  if (mimeType === 'application/pdf') {
    return <iframe src={viewUrl} title="PDF preview" style={{ width: '100%', height: 500, border: 'none', borderRadius: 8, marginTop: 12, background: '#fff' }} />;
  }
  if (mimeType.startsWith('text/')) {
    return <iframe src={viewUrl} title="Text preview" style={{ width: '100%', height: 400, border: '1px solid #2a2e45', borderRadius: 8, marginTop: 12, background: '#1a1b2e', color: '#e8eaf0' }} />;
  }

  return <p style={{ color: '#8b8ea8', fontSize: '0.85rem', marginTop: 12 }}>Preview not available for this file type ({mimeType}).</p>;
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

  // Download entire bundle as ZIP
  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      const { data } = await sharesAPI.download(token, password || undefined);
      const url = window.URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = isBatch
        ? `MiniDrive_Shared_${shareData.files?.length || 0}_files.zip`
        : (shareData.file?.originalName || shareData.file?.filename || 'download');
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError('Download failed. The link may have expired.');
    } finally {
      setDownloadingAll(false);
    }
  };

  // Download individual file from batch
  const handleDownloadSingle = async (file) => {
    setDownloadingFileId(file._id);
    try {
      const { data } = await sharesAPI.downloadBatchFile(token, file._id, password || undefined);
      const url = window.URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.originalName || file.filename;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError('Download failed for this file.');
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

            {permission === 'DOWNLOAD' && (
              <button
                className="btn btn-primary btn-lg shared-download-btn"
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

            {permission === 'VIEW' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#a78bfa', fontSize: '0.875rem', marginBottom: 8 }}>
                  <HiOutlineEye /> View-only — downloads are not permitted
                </div>
                <InlinePreview mimeType={singleFile.mimeType} viewUrl={sharesAPI.viewUrl(token, password || undefined)} />
              </>
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
            viewUrl={sharesAPI.viewBatchFileUrl(token, previewFile._id, password || undefined)}
            onClose={() => setPreviewFile(null)}
            onDownload={permission === 'DOWNLOAD' ? () => handleDownloadSingle(previewFile) : undefined}
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
