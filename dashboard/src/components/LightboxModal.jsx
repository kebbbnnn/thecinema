import React from 'react';
import { X, ExternalLink } from 'lucide-react';

export function LightboxModal({ isOpen, imageUrl, title, onClose }) {
  if (!isOpen || !imageUrl) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="lightbox-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-header"
              style={{ padding: '0.4rem 0.75rem' }}
            >
              <ExternalLink size={14} />
              <span>Full Res</span>
            </a>
            <button
              className="btn-ghost"
              style={{ padding: '0.4rem', borderRadius: '50%' }}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <img src={imageUrl} alt={title} className="lightbox-img" />
      </div>
    </div>
  );
}
