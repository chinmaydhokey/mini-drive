import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { HiOutlineCloud } from 'react-icons/hi2';

export default function Register() {
  const [form, setForm] = useState({ email: '', username: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    setLoading(true);
    try {
      await register(form.email, form.username, form.password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="logo-icon"><HiOutlineCloud /></div>
          MiniDrive
        </div>
        <h1 className="auth-title">Create account</h1>
        <p className="auth-subtitle">Start storing your files securely</p>

        {error && <div className="form-error" style={{ textAlign: 'center', marginBottom: 16 }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" name="email" className="form-input" value={form.email}
              onChange={handleChange} placeholder="you@example.com" required />
          </div>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input type="text" name="username" className="form-input" value={form.username}
              onChange={handleChange} placeholder="johndoe" required minLength={3} />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input type="password" name="password" className="form-input" value={form.password}
              onChange={handleChange} placeholder="Min 8 chars, 1 upper, 1 number" required minLength={8} />
          </div>
          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <input type="password" name="confirm" className="form-input" value={form.confirm}
              onChange={handleChange} placeholder="••••••••" required />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Create Account'}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
