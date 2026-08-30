import React, { useState, useMemo } from 'react';
import { X, Search, Images, Check, Loader2, Sparkles, Building2 } from 'lucide-react';

export function MediaLibraryModal({
  isOpen,
  onClose,
  targetTheater,
  mediaLibrary = [],
  onSelectPhoto,
  isLinking = false,
}) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter media library items by search query safely
  const filteredLibrary = useMemo(() => {
    const list = Array.isArray(mediaLibrary) ? mediaLibrary : [];
    if (!searchQuery.trim()) return list;
    const query = searchQuery.toLowerCase();
    return list.filter((item) => {
      const usedBy = Array.isArray(item.usedBy) ? item.usedBy : [];
      const locations = Array.isArray(item.locations) ? item.locations : [];
      const matchName = usedBy.some((name) =>
        String(name).toLowerCase().includes(query)
      );
      const matchLocation = locations.some((loc) =>
        String(loc).toLowerCase().includes(query)
      );
      return matchName || matchLocation;
    });
  }, [mediaLibrary, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-library-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">
              <Images size={20} style={{ color: 'var(--accent-gold)' }} />
              <span>Media Library</span>
            </div>
            {targetTheater ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Assign an existing uploaded photo to <strong style={{ color: 'var(--accent-gold-light)' }}>{targetTheater.name}</strong>
              </p>
            ) : (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Browse all photos currently in use across your cinemas
              </p>
            )}
          </div>
          <button
            type="button"
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
            autoFocus
          />
        </div>

        {/* Media Grid */}
        <div className="library-grid-container">
          {mediaLibrary.length === 0 ? (
            <div className="empty-state" style={{ padding: '2.5rem 1rem' }}>
              <Images size={36} className="empty-icon" />
              <h4>No photos in Media Library yet</h4>
              <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Upload your first theater photo, and it will automatically appear here for reuse across branches.
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
              {filteredLibrary.map((item, idx) => {
                const usedByList = Array.isArray(item.usedBy) ? item.usedBy : [];
                const displayThumbnail = item.thumbnailUrl || item.url;
                const isAlreadyCurrent = targetTheater && targetTheater.custom_image_url === item.url;

                return (
                  <div key={item.fileId || item.url || idx} className="library-card">
                    <div className="library-media-wrap">
                      <img
                        src={displayThumbnail}
                        alt="Uploaded Cinema"
                        className="library-img"
                        loading="lazy"
                      />
                      <div className="library-used-count">
                        <Sparkles size={11} />
                        <span>{usedByList.length} theater{usedByList.length !== 1 ? 's' : ''}</span>
                      </div>
                    </div>

                    <div className="library-card-body">
                      <div className="library-used-by-list" title={usedByList.join(', ')}>
                        <Building2 size={12} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
                        <span style={{ color: 'var(--text-muted)' }}>Used by:</span>{' '}
                        <strong>
                          {usedByList.slice(0, 2).join(', ')}
                          {usedByList.length > 2 ? ` +${usedByList.length - 2} more` : ''}
                        </strong>
                      </div>

                      {targetTheater && (
                        <button
                          type="button"
                          className={`btn-card ${isAlreadyCurrent ? 'btn-ghost' : 'btn-primary'}`}
                          style={{ width: '100%', marginTop: '0.5rem' }}
                          onClick={() => onSelectPhoto(item)}
                          disabled={isLinking || isAlreadyCurrent}
                        >
                          {isLinking ? (
                            <Loader2 size={14} className="spin-animation" />
                          ) : isAlreadyCurrent ? (
                            <Check size={14} style={{ color: 'var(--accent-emerald)' }} />
                          ) : (
                            <Check size={14} />
                          )}
                          <span>{isAlreadyCurrent ? 'Current Photo' : 'Use This Photo'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
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
