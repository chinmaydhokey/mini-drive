import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineCloud, HiOutlinePhoto, HiOutlineFilm,
  HiOutlineMusicalNote, HiOutlineDocumentText, HiOutlineDocument,
} from 'react-icons/hi2';
import { filesAPI } from '../services/api';

function formatSize(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

const TYPE_COLORS = {
  Images: '#ff6b6b', Videos: '#ffaa00', Audio: '#a855f7',
  PDFs: '#ef4444', Text: '#0095ff', Other: '#9ca3b8',
};

const TYPE_ICONS = {
  Images: HiOutlinePhoto, Videos: HiOutlineFilm, Audio: HiOutlineMusicalNote,
  PDFs: HiOutlineDocumentText, Text: HiOutlineDocumentText, Other: HiOutlineDocument,
};

export default function Storage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    filesAPI.storage().then(({ data }) => {
      setStats(data.data);
      setLoading(false);
    }).catch(() => {
      toast.error('Failed to load storage stats.');
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>;
  }

  if (!stats) return null;

  const usagePercent = parseFloat(stats.usagePercent) || 0;
  const barClass = usagePercent > 90 ? 'danger' : usagePercent > 70 ? 'warning' : '';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Storage</h1>
      </div>

      {/* Main storage card */}
      <div className="storage-card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 'var(--radius-lg)',
            background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, color: 'white',
          }}>
            <HiOutlineCloud />
          </div>
          <div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>
              {stats.storageUsedFormatted}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              of {stats.storageQuotaFormatted} used ({stats.usagePercent}%)
            </div>
          </div>
        </div>

        <div className="storage-bar" style={{ height: 8, marginBottom: 8 }}>
          <div className={`storage-bar-fill ${barClass}`}
            style={{ width: `${Math.max(usagePercent, 0.5)}%` }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <span>{stats.storageUsedFormatted} used</span>
          <span>{formatSize(stats.storageQuota - stats.storageUsed)} free</span>
        </div>
      </div>

      {/* Breakdown by type */}
      <div className="storage-card">
        <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 600, marginBottom: 16 }}>
          Storage Breakdown
        </h3>
        {stats.breakdown.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', padding: '16px 0' }}>
            No files uploaded yet.
          </div>
        ) : (
          <div className="storage-breakdown">
            {stats.breakdown.map((item) => {
              const Icon = TYPE_ICONS[item.type] || HiOutlineDocument;
              const color = TYPE_COLORS[item.type] || '#9ca3b8';
              return (
                <div key={item.type} className="breakdown-item">
                  <div className="breakdown-dot" style={{ background: color }} />
                  <div>
                    <div className="breakdown-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon style={{ fontSize: 14 }} /> {item.type}
                    </div>
                    <div className="breakdown-value">
                      {item.sizeFormatted} · {item.count} file{item.count !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Trash info */}
        {stats.trash && stats.trash.count > 0 && (
          <div style={{
            marginTop: 16, padding: '12px 14px',
            background: 'var(--warning-light)', borderRadius: 'var(--radius-md)',
            fontSize: 'var(--fs-sm)', color: 'var(--warning)',
          }}>
            🗑️ {stats.trash.count} item(s) in trash ({formatSize(stats.trash.totalSize)})
          </div>
        )}
      </div>
    </div>
  );
}
