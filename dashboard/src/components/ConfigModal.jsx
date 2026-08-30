import React, { useState } from 'react';
import { Key, X, Server, Check } from 'lucide-react';

export function ConfigModal({
  isOpen,
  onClose,
  apiUrl,
  adminKey,
  onSave,
}) {
  const [currentUrl, setCurrentUrl] = useState(apiUrl || '');
  const [currentKey, setCurrentKey] = useState(adminKey || '');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(currentUrl.trim(), currentKey.trim());
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Key size={20} style={{ color: 'var(--accent-gold)' }} />
            <span>Worker API Configuration</span>
          </div>
          <button className="btn-ghost" style={{ padding: '0.4rem', borderRadius: '50%' }} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">
                <Server size={14} style={{ display: 'inline', marginRight: '4px' }} />
                Cloudflare Worker API URL
              </label>
              <input
                type="url"
                className="form-input"
                placeholder="https://thecinema.youraccount.workers.dev"
                value={currentUrl}
                onChange={(e) => setCurrentUrl(e.target.value)}
                required
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Base URL of your deployed Worker or http://localhost:8787 for local testing.
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">
                <Key size={14} style={{ display: 'inline', marginRight: '4px' }} />
                Admin API Key (`X-Admin-Key`)
              </label>
              <input
                type="password"
                className="form-input"
                placeholder="Enter secret ADMIN_API_KEY..."
                value={currentKey}
                onChange={(e) => setCurrentKey(e.target.value)}
                required
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Matches the secret key configured in your Cloudflare Worker environment.
              </span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-card btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-card btn-primary">
              <Check size={16} />
              <span>Save & Connect</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
