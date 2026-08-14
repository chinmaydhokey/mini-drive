import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineTrash, HiOutlineArrowUturnLeft, HiOutlineXMark,
  HiOutlineDocument, HiOutlineFolder, HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import { trashAPI, bulkAPI } from '../services/api';

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

export default function Trash() {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedItems, setSelectedItems] = useState(new Set());

  const loadTrash = async () => {
    setLoading(true);
    try {
      const { data } = await trashAPI.list();
      setFiles(data.data.files);
      setFolders(data.data.folders);
      setSelectedItems(new Set());
    } catch {
      toast.error('Failed to load trash.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTrash(); }, []);

  const handleRestore = async (id, type) => {
    try {
      await trashAPI.restore(id, type);
      toast.success(`${type === 'folder' ? 'Folder' : 'File'} restored.`);
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Restore failed.');
    }
  };

  const handlePermanentDelete = async (id, type) => {
    try {
      await trashAPI.permanentDelete(id, type);
      toast.success('Permanently deleted.');
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Delete failed.');
    }
  };

  const handleEmptyTrash = async () => {
    try {
      const { data } = await trashAPI.empty();
      toast.success(`Trash emptied. Freed ${data.data.freedFormatted}.`);
      setFiles([]); setFolders([]); setConfirmEmpty(false);
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Failed to empty trash.');
    }
  };

  const handleBulkRestore = async () => {
    try {
      const ids = Array.from(selectedItems).map(item => {
        const [type, id] = item.split(':');
        return { id, type };
      });
      await bulkAPI.restore(ids);
      toast.success(`Restored ${ids.length} items.`);
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Bulk restore failed.');
    }
  };

  const handleBulkPermanentDelete = async () => {
    try {
      const ids = Array.from(selectedItems).map(item => {
        const [type, id] = item.split(':');
        return { id, type };
      });
      await bulkAPI.permanentDelete(ids);
      toast.success(`Permanently deleted ${ids.length} items.`);
      setConfirmBulkDelete(false);
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Bulk delete failed.');
    }
  };

  const toggleSelection = (idStr) => {
    const newSet = new Set(selectedItems);
    if (newSet.has(idStr)) newSet.delete(idStr);
    else newSet.add(idStr);
    setSelectedItems(newSet);
  };

  const allItems = [
    ...folders.map(f => `folder:${f._id}`),
    ...files.map(f => `file:${f._id}`)
  ];

  const handleSelectAll = (e) => {
    if (e.target.checked) setSelectedItems(new Set(allItems));
    else setSelectedItems(new Set());
  };

  if (loading) {
    return <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>;
  }

  const isEmpty = files.length === 0 && folders.length === 0;
  const allSelected = allItems.length > 0 && selectedItems.size === allItems.length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Trash</h1>
        {!isEmpty && (
          <button className="btn btn-danger" onClick={() => setConfirmEmpty(true)}>
            <HiOutlineTrash /> Empty Trash
          </button>
        )}
      </div>

      {selectedItems.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', backgroundColor: 'var(--surface)', borderRadius: 8,
          marginBottom: 16, border: '1px solid var(--border)'
        }}>
          <span style={{ fontWeight: 500 }}>{selectedItems.size} selected</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={handleBulkRestore}>
              Restore Selected
            </button>
            <button className="btn btn-danger" onClick={() => setConfirmBulkDelete(true)}>
              Delete Selected Forever
            </button>
          </div>
        </div>
      )}

      {isEmpty ? (
        <div className="empty-state">
          <div className="empty-state-icon"><HiOutlineTrash /></div>
          <div className="empty-state-title">Trash is empty</div>
          <div className="empty-state-text">Items you delete will appear here for 30 days.</div>
        </div>
      ) : (
        <table className="file-list-table">
          <thead>
            <tr>
              <th style={{ width: 40, paddingLeft: 16 }}>
                <input type="checkbox" checked={allSelected} onChange={handleSelectAll} />
              </th>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Deleted</th>
              <th style={{ width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {folders.map((f) => {
              const idStr = `folder:${f._id}`;
              return (
                <tr key={f._id} className={`file-list-row ${selectedItems.has(idStr) ? 'selected' : ''}`}>
                  <td style={{ paddingLeft: 16 }}>
                    <input type="checkbox" checked={selectedItems.has(idStr)} onChange={() => toggleSelection(idStr)} />
                  </td>
                  <td>
                    <div className="file-list-name">
                      <div className="file-list-icon file-type-folder"><HiOutlineFolder /></div>
                      {f.name}
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>Folder</td>
                  <td>—</td>
                  <td style={{ color: 'var(--text-muted)' }}>{formatDate(f.deletedAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-ghost" title="Restore" onClick={() => handleRestore(f._id, 'folder')}>
                        <HiOutlineArrowUturnLeft />
                      </button>
                      <button className="btn btn-sm btn-ghost" title="Delete forever" style={{ color: 'var(--danger)' }}
                        onClick={() => handlePermanentDelete(f._id, 'folder')}>
                        <HiOutlineXMark />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {files.map((f) => {
              const idStr = `file:${f._id}`;
              return (
                <tr key={f._id} className={`file-list-row ${selectedItems.has(idStr) ? 'selected' : ''}`}>
                  <td style={{ paddingLeft: 16 }}>
                    <input type="checkbox" checked={selectedItems.has(idStr)} onChange={() => toggleSelection(idStr)} />
                  </td>
                  <td>
                    <div className="file-list-name">
                      <div className="file-list-icon file-type-other"><HiOutlineDocument /></div>
                      {f.filename}
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{f.mimeType?.split('/')[1] || 'File'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{formatSize(f.size)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{formatDate(f.deletedAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-ghost" title="Restore" onClick={() => handleRestore(f._id, 'file')}>
                        <HiOutlineArrowUturnLeft />
                      </button>
                      <button className="btn btn-sm btn-ghost" title="Delete forever" style={{ color: 'var(--danger)' }}
                        onClick={() => handlePermanentDelete(f._id, 'file')}>
                        <HiOutlineXMark />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Empty trash confirmation */}
      {confirmEmpty && (
        <div className="modal-overlay" onClick={() => setConfirmEmpty(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>
              <HiOutlineExclamationTriangle style={{ marginRight: 8 }} /> Empty Trash?
            </h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              This will permanently delete all {files.length + folders.length} item(s).
              This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmEmpty(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleEmptyTrash}>Delete Forever</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirmation */}
      {confirmBulkDelete && (
        <div className="modal-overlay" onClick={() => setConfirmBulkDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>
              <HiOutlineExclamationTriangle style={{ marginRight: 8 }} /> Delete Selected?
            </h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              This will permanently delete {selectedItems.size} selected item(s).
              This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleBulkPermanentDelete}>Delete Forever</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
