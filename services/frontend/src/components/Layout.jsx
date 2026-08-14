import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { filesAPI } from '../services/api';
import {
  HiOutlineCloud, HiOutlineFolderOpen, HiOutlineTrash,
  HiOutlineChartBar, HiOutlineMagnifyingGlass,
  HiOutlineArrowRightOnRectangle, HiOutlineShieldCheck,
  HiOutlineShare,
} from 'react-icons/hi2';

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [storage, setStorage] = useState(null);

  useEffect(() => {
    filesAPI.storage().then(({ data }) => setStorage(data.data)).catch(() => {});
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const usagePercent = storage ? parseFloat(storage.usagePercent) : 0;
  const barClass = usagePercent > 90 ? 'danger' : usagePercent > 70 ? 'warning' : '';

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon"><HiOutlineCloud /></div>
          MiniDrive
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="icon"><HiOutlineFolderOpen /></span>
            My Drive
          </NavLink>
          <NavLink to="/storage" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="icon"><HiOutlineChartBar /></span>
            Storage
          </NavLink>
          <NavLink to="/trash" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="icon"><HiOutlineTrash /></span>
            Trash
          </NavLink>
          <NavLink to="/shared-with-me" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="icon"><HiOutlineShare /></span>
            Shared with me
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span className="icon"><HiOutlineShieldCheck /></span>
              Admin
            </NavLink>
          )}
        </nav>

        {/* Storage widget at bottom */}
        {storage && (
          <div className="storage-widget">
            <div className="storage-label">
              <span>{storage.storageUsedFormatted}</span>
              <span>of {storage.storageQuotaFormatted}</span>
            </div>
            <div className="storage-bar">
              <div className={`storage-bar-fill ${barClass}`}
                style={{ width: `${Math.max(usagePercent, 0.5)}%` }} />
            </div>
          </div>
        )}
      </aside>

      {/* Main area */}
      <div className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <form onSubmit={handleSearch} className="search-container">
              <HiOutlineMagnifyingGlass className="search-icon" />
              <input
                type="text" className="search-input"
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </form>
          </div>
          <div className="topbar-right">
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              {user?.username}
            </span>
            <div className="user-avatar" title={user?.email}>
              {user?.username?.charAt(0).toUpperCase() || '?'}
            </div>
            <button className="btn btn-icon btn-ghost" onClick={handleLogout} title="Logout">
              <HiOutlineArrowRightOnRectangle />
            </button>
          </div>
        </header>

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
