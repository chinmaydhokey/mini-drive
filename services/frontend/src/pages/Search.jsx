import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  HiOutlineMagnifyingGlass, HiOutlineArrowDownTray,
  HiOutlineDocument, HiOutlinePhoto, HiOutlineFilm,
} from 'react-icons/hi2';
import { filesAPI } from '../services/api';

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Search() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    filesAPI.search({ q: query, limit: 50 }).then(({ data }) => {
      setResults(data.data.files);
      setTotal(data.data.pagination.total);
      setLoading(false);
    }).catch(() => {
      toast.error('Search failed.');
      setLoading(false);
    });
  }, [query]);

  const handleDownload = async (file) => {
    try {
      const { data } = await filesAPI.download(file._id);
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = file.filename; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Download failed.'); }
  };

  if (loading) {
    return <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          Search: "{query}"
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', fontWeight: 400, marginLeft: 12 }}>
            {total} result{total !== 1 ? 's' : ''}
          </span>
        </h1>
      </div>

      {results.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><HiOutlineMagnifyingGlass /></div>
          <div className="empty-state-title">No results found</div>
          <div className="empty-state-text">Try a different search term.</div>
        </div>
      ) : (
        <table className="file-list-table">
          <thead>
            <tr><th>Name</th><th>Size</th><th>Date</th><th style={{ width: 80 }} /></tr>
          </thead>
          <tbody>
            {results.map((f) => (
              <tr key={f._id} className="file-list-row">
                <td>
                  <div className="file-list-name">
                    <div className="file-list-icon file-type-other"><HiOutlineDocument /></div>
                    {f.filename}
                  </div>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{formatSize(f.size)}</td>
                <td style={{ color: 'var(--text-muted)' }}>{formatDate(f.createdAt)}</td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => handleDownload(f)}>
                    <HiOutlineArrowDownTray />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
