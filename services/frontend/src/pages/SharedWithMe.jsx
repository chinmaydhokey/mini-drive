import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineShare, HiOutlineDocument, HiOutlineFolder,
  HiOutlineArrowDownTray, HiOutlineUser, HiOutlineEye,
  HiOutlineLockClosed,
} from 'react-icons/hi2';
import { sharesAPI, filesAPI } from '../services/api';
import FileViewerModal from '../components/FileViewerModal';

function formatSize(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function SharedWithMe() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewerItem, setViewerItem] = useState(null);

  useEffect(() => {
    fetchSharedItems();
  }, []);

  const fetchSharedItems = async () => {
    try {
      setLoading(true);
      const { data } = await sharesAPI.sharedWithMe();
      setItems(data.data?.items || []);
    } catch (err) {
      toast.error('Failed to load shared items');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (fileId, name, shareToken) => {
    try {
      toast.loading('Preparing download...', { id: 'download' });
      let blob;
      try {
        const { data } = await filesAPI.download(fileId);
        blob = data;
      } catch (err) {
        if (shareToken) {
          const { data } = await sharesAPI.download(shareToken);
          blob = data;
        } else {
          throw err;
        }
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();

      toast.success('Download started', { id: 'download' });
    } catch (err) {
      console.error('Download error:', err);
      toast.error('Failed to download file', { id: 'download' });
    }
  };

  const handleOpenViewer = (item) => {
    if (item.resourceType === 'folder') return;
    const fileObj = item.file || {};
    const fileId = fileObj._id;
    const viewUrl = fileId ? filesAPI.viewUrl(fileId) : sharesAPI.viewUrl(item.token);
    setViewerItem({
      file: fileObj,
      permission: item.myPermission || 'VIEW',
      viewUrl,
      shareToken: item.token,
    });
  };

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Shared with me</h1>
        </div>
        <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Shared with me</h1>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><HiOutlineShare /></div>
          <div className="empty-state-title">Nothing shared with you yet</div>
          <div className="empty-state-text">Files and folders others share with you will appear here.</div>
        </div>
      ) : (
        <table className="file-list-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Shared By</th>
              <th>Permission</th>
              <th>Shared On</th>
              <th style={{ width: 120, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isFolder = item.resourceType === 'folder';
              const name = isFolder
                ? (item.folder?.name || 'Unnamed Folder')
                : (item.file?.originalName || item.file?.filename || 'Unnamed File');
              const size = isFolder ? null : item.file?.size;
              const sharedByEmail = item.sharedBy?.email || 'Unknown User';
              const permissionLevel = item.myPermission || 'VIEW';
              const sharedAt = item.sharedAt;
              const fileId = item.file?._id;

              return (
                <tr key={item.shareId} className="file-list-row">
                  <td onClick={() => !isFolder && handleOpenViewer(item)} style={{ cursor: !isFolder ? 'pointer' : 'default' }}>
                    <div className="file-list-name">
                      <div className={`file-list-icon ${isFolder ? 'file-type-folder' : 'file-type-other'}`}>
                        {isFolder ? <HiOutlineFolder /> : <HiOutlineDocument />}
                      </div>
                      <div>
                        {name}
                        {size != null && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginLeft: 8 }}>
                            {formatSize(size)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                      <HiOutlineUser />
                      {sharedByEmail}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${permissionLevel === 'DOWNLOAD' ? 'badge-success' : 'badge-warning'}`}>
                      {permissionLevel === 'VIEW' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <HiOutlineLockClosed /> View Only
                        </span>
                      ) : (
                        'Can Download'
                      )}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{formatDate(sharedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {!isFolder && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => handleOpenViewer(item)}
                          title="Preview / View"
                        >
                          <HiOutlineEye />
                        </button>
                      )}
                      {!isFolder && permissionLevel === 'DOWNLOAD' && (fileId || item.token) && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => handleDownload(fileId, name, item.token)}
                          title="Download"
                        >
                          <HiOutlineArrowDownTray />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Viewer Modal */}
      {viewerItem && (
        <FileViewerModal
          file={viewerItem.file}
          permission={viewerItem.permission}
          viewUrl={viewerItem.viewUrl}
          onClose={() => setViewerItem(null)}
          onDownload={viewerItem.permission === 'DOWNLOAD'
            ? () => handleDownload(viewerItem.file?._id, viewerItem.file?.originalName || viewerItem.file?.filename, viewerItem.shareToken)
            : undefined}
        />
      )}
    </div>
  );
}

export default SharedWithMe;
