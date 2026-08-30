import React from 'react';
import { Building2, CheckCircle2, ImageOff } from 'lucide-react';

export function Metrics({ total, withCustomImage, missingImage }) {
  const percentage = total > 0 ? Math.round((withCustomImage / total) * 100) : 0;

  return (
    <div className="metrics-grid">
      <div className="metric-card">
        <div className="metric-header">
          <span className="metric-label">Total Theaters</span>
          <div className="metric-icon-wrap metric-icon-gold">
            <Building2 size={20} />
          </div>
        </div>
        <div className="metric-value">{total}</div>
        <div className="metric-footer">Active Philippine cinema branches</div>
      </div>

      <div className="metric-card">
        <div className="metric-header">
          <span className="metric-label">Custom Photos Added</span>
          <div className="metric-icon-wrap metric-icon-emerald">
            <CheckCircle2 size={20} />
          </div>
        </div>
        <div className="metric-value">{withCustomImage}</div>
        <div className="metric-footer">{percentage}% coverage on ImageKit CDN</div>
        <div className="progress-container">
          <div className="progress-fill" style={{ width: `${percentage}%` }} />
        </div>
      </div>

      <div className="metric-card">
        <div className="metric-header">
          <span className="metric-label">Missing Images</span>
          <div className="metric-icon-wrap metric-icon-rose">
            <ImageOff size={20} />
          </div>
        </div>
        <div className="metric-value">{missingImage}</div>
        <div className="metric-footer">Theaters needing custom photography</div>
      </div>
    </div>
  );
}
