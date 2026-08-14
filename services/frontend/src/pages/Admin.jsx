import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import api from '../services/api';
import {
  HiOutlineUsers, HiOutlineServer, HiOutlineCircleStack,
  HiOutlineChartBar, HiOutlineShieldCheck, HiOutlineExclamationTriangle,
  HiOutlineCheckCircle, HiOutlineXCircle, HiOutlineArrowPath,
} from 'react-icons/hi2';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

export default function Admin() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [nodeHealth, setNodeHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsRes, usersRes, nodesRes] = await Promise.all([
        api.get('/admin/stats'),
        api.get('/admin/users'),
        api.get('/admin/nodes'),
      ]);
      setStats(statsRes.data.data);
      setUsers(usersRes.data.data.users);
      setNodeHealth(nodesRes.data.data);
    } catch (err) {
      if (err.response?.status === 403) {
        toast.error('Admin access required.');
      } else {
        toast.error('Failed to load admin data.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const toggleUserActive = async (userId, isActive) => {
    try {
      await api.patch(`/admin/users/${userId}`, { isActive: !isActive });
      toast.success(`User ${isActive ? 'deactivated' : 'activated'}.`);
      loadData();
    } catch (err) {
      toast.error('Failed to update user.');
    }
  };

  const changeRole = async (userId, currentRole) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    try {
      await api.patch(`/admin/users/${userId}`, { role: newRole });
      toast.success(`Role changed to ${newRole}.`);
      loadData();
    } catch (err) {
      toast.error('Failed to change role.');
    }
  };

  const drainNode = async (nodeId) => {
    if (!confirm(`Drain node ${nodeId}? This will re-replicate all its chunks.`)) return;
    try {
      const { data } = await api.post(`/admin/nodes/${nodeId}/drain`);
      toast.success(data.data.message || `Node ${nodeId} draining.`);
      setTimeout(loadData, 2000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Drain failed.');
    }
  };

  if (loading && !stats) {
    return <div className="page-loading"><div className="spinner" style={{ width: 36, height: 36 }} /></div>;
  }

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1><HiOutlineShieldCheck /> Admin Dashboard</h1>
        <button className="btn btn-secondary" onClick={loadData}>
          <HiOutlineArrowPath /> Refresh
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="admin-tabs">
        {['overview', 'users', 'nodes'].map((tab) => (
          <button
            key={tab}
            className={`admin-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' && <HiOutlineChartBar />}
            {tab === 'users' && <HiOutlineUsers />}
            {tab === 'nodes' && <HiOutlineServer />}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && stats && (
        <div className="admin-grid">
          <div className="stat-card">
            <HiOutlineUsers className="stat-icon" style={{ color: '#6366f1' }} />
            <div className="stat-content">
              <div className="stat-value">{stats.users.total}</div>
              <div className="stat-label">Total Users</div>
              <div className="stat-sub">{stats.users.active} active</div>
            </div>
          </div>
          <div className="stat-card">
            <HiOutlineCircleStack className="stat-icon" style={{ color: '#00d68f' }} />
            <div className="stat-content">
              <div className="stat-value">{stats.files.total}</div>
              <div className="stat-label">Total Files</div>
              <div className="stat-sub">{stats.files.trashed} in trash</div>
            </div>
          </div>
          <div className="stat-card">
            <HiOutlineChartBar className="stat-icon" style={{ color: '#a78bfa' }} />
            <div className="stat-content">
              <div className="stat-value">{formatBytes(stats.storage.totalBytes)}</div>
              <div className="stat-label">Storage Used</div>
            </div>
          </div>

          {nodeHealth && (
            <>
              <div className="stat-card">
                <HiOutlineServer className="stat-icon" style={{ color: '#38bdf8' }} />
                <div className="stat-content">
                  <div className="stat-value">{nodeHealth.nodesOnline}/{nodeHealth.totalNodes}</div>
                  <div className="stat-label">Nodes Online</div>
                  <div className="stat-sub">{nodeHealth.totalChunks} chunks</div>
                </div>
              </div>
              {nodeHealth.degradedChunks > 0 && (
                <div className="stat-card warning">
                  <HiOutlineExclamationTriangle className="stat-icon" style={{ color: '#fbbf24' }} />
                  <div className="stat-content">
                    <div className="stat-value">{nodeHealth.degradedChunks}</div>
                    <div className="stat-label">Degraded Chunks</div>
                  </div>
                </div>
              )}
              {nodeHealth.s3BackedChunks !== undefined && (
                <div className="stat-card">
                  <HiOutlineCircleStack className="stat-icon" style={{ color: '#f97316' }} />
                  <div className="stat-content">
                    <div className="stat-value">{nodeHealth.s3BackedChunks}</div>
                    <div className="stat-label">S3 Backed</div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Storage</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u._id}>
                  <td className="user-name">{u.username}</td>
                  <td className="user-email">{u.email}</td>
                  <td>
                    <span className={`role-badge ${u.role}`}>{u.role}</span>
                  </td>
                  <td>{formatBytes(u.storageUsed)} / {formatBytes(u.storageQuota)}</td>
                  <td>
                    {u.isActive ? (
                      <span className="status-badge active"><HiOutlineCheckCircle /> Active</span>
                    ) : (
                      <span className="status-badge inactive"><HiOutlineXCircle /> Inactive</span>
                    )}
                  </td>
                  <td className="action-cell">
                    <button
                      className={`btn btn-sm ${u.isActive ? 'btn-danger' : 'btn-success'}`}
                      onClick={() => toggleUserActive(u._id, u.isActive)}
                    >
                      {u.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => changeRole(u._id, u.role)}
                    >
                      {u.role === 'admin' ? '→ User' : '→ Admin'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Nodes Tab */}
      {activeTab === 'nodes' && nodeHealth && (
        <div className="admin-nodes">
          <div className="node-meta">
            <p>Cluster Status: <strong className={`status-${nodeHealth.status}`}>{nodeHealth.status?.toUpperCase()}</strong></p>
            <p>Replication Factor: <strong>{nodeHealth.replicationFactor}×</strong></p>
            <p>Chunk Size: <strong>{nodeHealth.chunkSize ? formatBytes(nodeHealth.chunkSize) : 'N/A'}</strong></p>
          </div>

          {nodeHealth.healthMonitor && (
            <div className="worker-status">
              <h3>Background Workers</h3>
              <div className="worker-grid">
                <div className="worker-card">
                  <h4>Health Monitor</h4>
                  <p>Status: {nodeHealth.healthMonitor.running ? '🟢 Running' : '🔴 Stopped'}</p>
                  <p>Check Interval: {nodeHealth.healthMonitor.checkIntervalMs / 1000}s</p>
                </div>
                <div className="worker-card">
                  <h4>Re-replication Worker</h4>
                  <p>Status: {nodeHealth.replicationWorker?.running ? '🟢 Running' : '🔴 Stopped'}</p>
                  <p>Repaired: {nodeHealth.replicationWorker?.chunksRepaired || 0}</p>
                  <p>Failed: {nodeHealth.replicationWorker?.chunksFailed || 0}</p>
                </div>
                {nodeHealth.s3ColdTier && (
                  <div className="worker-card">
                    <h4>S3 Cold Tier</h4>
                    <p>Status: {nodeHealth.s3ColdTier.enabled ? (nodeHealth.s3ColdTier.running ? '🟢 Running' : '🔴 Stopped') : '⚪ Disabled'}</p>
                    {nodeHealth.s3ColdTier.bucket && <p>Bucket: {nodeHealth.s3ColdTier.bucket}</p>}
                    <p>Backed Up: {nodeHealth.s3ColdTier.chunksBackedUp || 0}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        .admin-page { padding: 0; }
        .admin-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 24px;
        }
        .admin-header h1 {
          display: flex; align-items: center; gap: 10px;
          font-size: 1.5rem; color: #e8eaf0;
        }
        .admin-tabs {
          display: flex; gap: 4px; margin-bottom: 24px;
          border-bottom: 1px solid #2a2e45; padding-bottom: 0;
        }
        .admin-tab {
          background: none; border: none; color: #8b8ea8; padding: 10px 20px;
          cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; gap: 6px;
          border-bottom: 2px solid transparent; transition: all 0.2s;
        }
        .admin-tab:hover { color: #c4c6d4; }
        .admin-tab.active { color: #6366f1; border-bottom-color: #6366f1; }
        .admin-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }
        .stat-card {
          background: rgba(255,255,255,0.03); border: 1px solid #2a2e45;
          border-radius: 12px; padding: 20px; display: flex; align-items: center; gap: 16px;
          transition: border-color 0.2s;
        }
        .stat-card:hover { border-color: #3f4370; }
        .stat-card.warning { border-color: #fbbf2480; }
        .stat-icon { font-size: 36px; flex-shrink: 0; }
        .stat-value { font-size: 1.5rem; font-weight: 700; color: #e8eaf0; }
        .stat-label { color: #8b8ea8; font-size: 0.8rem; margin-top: 2px; }
        .stat-sub { color: #6b6e88; font-size: 0.75rem; }
        .admin-table-wrap { overflow-x: auto; }
        .admin-table {
          width: 100%; border-collapse: collapse; font-size: 0.875rem;
        }
        .admin-table th {
          text-align: left; padding: 12px 16px; color: #8b8ea8;
          border-bottom: 1px solid #2a2e45; font-weight: 500;
        }
        .admin-table td {
          padding: 12px 16px; border-bottom: 1px solid #1e2040; color: #c4c6d4;
        }
        .admin-table tr:hover td { background: rgba(255,255,255,0.02); }
        .user-name { font-weight: 600; color: #e8eaf0; }
        .user-email { color: #8b8ea8; }
        .role-badge {
          padding: 2px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600;
        }
        .role-badge.admin { background: #6366f120; color: #a78bfa; }
        .role-badge.user { background: #38bdf820; color: #38bdf8; }
        .status-badge {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 0.8rem;
        }
        .status-badge.active { color: #00d68f; }
        .status-badge.inactive { color: #ff3d71; }
        .action-cell { display: flex; gap: 6px; }
        .btn-sm { padding: 4px 10px; font-size: 0.75rem; border-radius: 6px; }
        .btn-danger { background: #ff3d7120; color: #ff3d71; border: 1px solid #ff3d7140; }
        .btn-danger:hover { background: #ff3d7130; }
        .btn-success { background: #00d68f20; color: #00d68f; border: 1px solid #00d68f40; }
        .btn-success:hover { background: #00d68f30; }
        .node-meta { color: #c4c6d4; margin-bottom: 24px; }
        .node-meta p { margin: 6px 0; }
        .node-meta strong { color: #e8eaf0; }
        .status-ok { color: #00d68f; }
        .status-degraded { color: #fbbf24; }
        .status-critical { color: #ff3d71; }
        .worker-status { margin-top: 24px; }
        .worker-status h3 { color: #e8eaf0; margin-bottom: 16px; }
        .worker-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 12px;
        }
        .worker-card {
          background: rgba(255,255,255,0.03); border: 1px solid #2a2e45;
          border-radius: 10px; padding: 16px;
        }
        .worker-card h4 { color: #c4c6d4; margin: 0 0 8px; font-size: 0.9rem; }
        .worker-card p { color: #8b8ea8; margin: 4px 0; font-size: 0.8rem; }
      `}</style>
    </div>
  );
}
