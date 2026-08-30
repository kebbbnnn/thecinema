import React, { useState, useRef } from 'react';
import { Upload, Trash2, Maximize2, MapPin, Loader2, Check, AlertCircle, ImageIcon } from 'lucide-react';

export function TheaterCard({
  theater,
  onUpload,
  onDelete,
  onPreview,
  isUploading,
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = useRef(null);

  const displayImage = theater.custom_image_url || theater.logo_url;
  const hasCustomImage = Boolean(theater.has_custom_image && theater.custom_image_url);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragActive(true);
  };

  const handleDragLeave = () => {
    setIsDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = (file) => {
    const validMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validMimes.includes(file.type.toLowerCase())) {
      alert('Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('File exceeds 5MB limit.');
      return;
    }
    onUpload(theater, file);
  };

  const handleDelete = async () => {
    if (window.confirm(`Are you sure you want to remove the custom image for ${theater.name}?`)) {
      setIsDeleting(true);
      try {
        await onDelete(theater);
      } finally {
        setIsDeleting(false);
      }
    }
  };

  return (
    <div className="theater-card">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
      />

      <div className="theater-media-wrap">
        {displayImage ? (
          <img
            src={theater.thumbnail_url || displayImage}
            alt={theater.name}
            className="theater-img"
            loading="lazy"
          />
        ) : (
          <div className="theater-img-placeholder">
            <ImageIcon size={36} />
            <span style={{ fontSize: '0.8rem' }}>No theater image</span>
          </div>
        )}

        <div className={`badge-status ${hasCustomImage ? 'badge-has-image' : 'badge-missing-image'}`}>
          {hasCustomImage ? (
            <>
              <Check size={12} strokeWidth={3} />
              <span>Custom Photo</span>
            </>
          ) : (
            <>
              <AlertCircle size={12} strokeWidth={3} />
              <span>Missing Photo</span>
            </>
          )}
        </div>
      </div>

      <div className="theater-card-body">
        <div>
          <h3 className="theater-title">{theater.name}</h3>
          <div className="theater-meta">
            <MapPin size={14} />
            <span>{theater.city || theater.province}</span>
            {theater.province && theater.city !== theater.province && (
              <span style={{ color: 'var(--text-muted)' }}>• {theater.province}</span>
            )}
          </div>
        </div>

        {/* Dropzone Area */}
        <div
          className={`card-dropzone ${isDragActive ? 'drag-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="dropzone-label">
            {isUploading ? (
              <>
                <Loader2 size={16} className="spin-animation" />
                <span>Uploading to ImageKit...</span>
              </>
            ) : (
              <>
                <Upload size={15} />
                <span>{hasCustomImage ? 'Drop to replace photo' : 'Drop photo here (or click)'}</span>
              </>
            )}
          </div>
        </div>

        <div className="card-actions-row">
          {hasCustomImage && (
            <>
              <button
                className="btn-card btn-ghost"
                onClick={() => onPreview(theater.custom_image_url, theater.name)}
                title="View Full Photo"
              >
                <Maximize2 size={14} />
                <span>Preview</span>
              </button>
              <button
                className="btn-card btn-danger"
                onClick={handleDelete}
                disabled={isDeleting}
                title="Delete Custom Image"
              >
                {isDeleting ? <Loader2 size={14} className="spin-animation" /> : <Trash2 size={14} />}
                <span>Delete</span>
              </button>
            </>
          )}
          {!hasCustomImage && (
            <button
              className="btn-card btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? <Loader2 size={14} className="spin-animation" /> : <Upload size={14} />}
              <span>Upload Photo</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
