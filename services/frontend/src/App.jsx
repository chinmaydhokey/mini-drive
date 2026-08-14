import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Trash from './pages/Trash';
import Storage from './pages/Storage';
import Search from './pages/Search';
import SharedFile from './pages/SharedFile';
import SharedWithMe from './pages/SharedWithMe';
import Admin from './pages/Admin';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" style={{ width: 36, height: 36 }} /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" style={{ width: 36, height: 36 }} /></div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1e2030',
              color: '#e8eaf0',
              border: '1px solid #2a2e45',
              borderRadius: '10px',
              fontSize: '0.875rem',
              fontFamily: 'Inter, sans-serif',
            },
            success: { iconTheme: { primary: '#00d68f', secondary: '#1e2030' } },
            error: { iconTheme: { primary: '#ff3d71', secondary: '#1e2030' } },
          }}
        />
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/shared/:token" element={<SharedFile />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="trash" element={<Trash />} />
            <Route path="shared-with-me" element={<SharedWithMe />} />
            <Route path="storage" element={<Storage />} />
            <Route path="search" element={<Search />} />
            <Route path="admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
