import React, { useState, useMemo } from 'react';
import { X, Search, Images, Check, Loader2, Sparkles } from 'lucide-react';

export function MediaLibraryModal({
  isOpen,
  onClose,
  targetTheater,
  mediaLibrary,
  onSelectPhoto,
  isLinking,
}) {
  const [searchQuery, setSearchQuery] = useState('');

  if (!isOpen || !targetTheater) return null;

  // Filter media library items by search query
  const filteredLibrary = useMemo(() => {
    if (!searchQuery.trim()) return mediaLibrary;
    const query = searchQuery.toLowerCase();
    return mediaLibrary.filter((item) => {
      const matchName = (item.usedBy || []).some((name) =>
        name.toLowerCase().includes(query)
      );
      const matchLocation = (item.locations || []).some((loc) =>
        loc.toLowerCase().includes(query)
      );
      return matchName || matchLocation;
    });
  }, [mediaLibrary, searchQuery]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-library-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">
              <Images size={20} style={{ color: 'var(--accent-gold)' }} />
              <span>Media Library</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Assign an existing uploaded photo to <strong style={{ color: 'var(--accent-gold-light)' }}>{targetTheater.name}</strong>
            </p>
          </div>
          <button
            className="btn-ghost"
            style={{ padding: '0.4rem', borderRadius: '50%' }}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        {/* Search Bar in Modal */}
        <div className="library-search-bar">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder="Filter library by theater name or location..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Media Grid */}
        <div className="library-grid-container">
          {mediaLibrary.length === 0 ? (
            <div className="empty-state" style={{ padding: '2.5rem 1rem' }}>
              <Images size={36} className="empty-icon" />
              <h4>No photos in Media Library yet</h4>
              <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Upload your first theater photo, and it will appear here for reuse across branches.
              </p>
            </div>
          ) : filteredLibrary.length === 0 ? (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <Search size={32} className="empty-icon" />
              <h4>No matching photos found</h4>
              <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Try searching for another theater branch name.
              </p>
            </div>
          ) : (
            <div className="library-grid">
              {filteredLibrary.map((item, idx) => (
                <div key={item.fileId || item.url || idx} className="library-card">
                  <div className="library-media-wrap">
                    <img
                      src={item.thumbnailUrl || item.url}
                      alt="Uploaded Cinema"
                      className="library-img"
                      loading="lazy"
                    />
                    <div className="library-used-count">
                      <Sparkles size={11} />
                      <span>{item.usedBy.length} theater{item.usedBy.length > 1 ? 's' : ''}</span>
                    </div>
                  </div>

                  <div className="library-card-body">
                    <div className="library-used-by-list" title={item.usedBy.join(', ')}>
                      <span style={{ color: 'var(--text-muted)' }}>Used by:</span>{' '}
                      <strong>{item.usedBy.slice(0, 2).join(', ')}{item.usedBy.length > 2 ? ` +${item.usedBy.length - 2} more` : ''}</strong>
                    </div>

                    <button
                      className="btn-card btn-primary"
                      style={{ width: '100%', marginTop: '0.5rem' }}
                      onClick={() => onSelectPhoto(item)}
                      disabled={isLinking}
                    >
                      {isLinking ? (
                        <Loader2 size={14} className="spin-animation" />
                      ) : (
                        <Check size={14} />
                      )}
                      <span>Use This Photo</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-card btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
