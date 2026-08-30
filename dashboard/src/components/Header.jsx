import React from 'react';
import { Film, Key, RefreshCw, Images } from 'lucide-react';

export function Header({
  isConnected,
  onOpenConfig,
  onRefresh,
  isRefreshing,
  onOpenLibrary,
  libraryCount = 0,
}) {
  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="logo-group">
          <div className="logo-badge">
            <Film size={22} />
          </div>
          <div>
            <h1 className="logo-title">The Cinema <span>Studio</span></h1>
            <p className="logo-subtitle">Theater Imagery & Asset Manager</p>
          </div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="btn-header"
            onClick={onOpenLibrary}
            title="Browse all distinct photos in your Media Library"
          >
            <Images size={16} />
            <span>Library ({libraryCount})</span>
          </button>

          <button
            type="button"
            className="btn-header"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Refresh Theaters"
          >
            <RefreshCw size={16} className={isRefreshing ? 'spin-animation' : ''} />
            <span>Refresh</span>
          </button>

          <button type="button" className="btn-header" onClick={onOpenConfig}>
            <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
            <Key size={15} />
            <span>{isConnected ? 'Connected' : 'Configure API'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
