import React, { useState, useEffect, useMemo } from 'react';
import { Search, Film, AlertCircle, RefreshCw } from 'lucide-react';
import { Header } from './components/Header';
import { Metrics } from './components/Metrics';
import { TheaterCard } from './components/TheaterCard';
import { ConfigModal } from './components/ConfigModal';
import { LightboxModal } from './components/LightboxModal';
import { ToastContainer } from './components/Toast';

export function App() {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('thecinema_api_url') || '');
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('thecinema_admin_key') || '');
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  const [theaters, setTheaters] = useState([]);
  const [metrics, setMetrics] = useState({ total: 0, with_custom_image: 0, missing_image: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [uploadingSlug, setUploadingSlug] = useState(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('missing'); // 'all' | 'missing' | 'has_image'
  const [selectedProvince, setSelectedProvince] = useState('all');

  // Modal / Toast State
  const [previewData, setPreviewData] = useState({ isOpen: false, url: '', title: '' });
  const [toasts, setToasts] = useState([]);

  const isConnected = Boolean(apiUrl && adminKey);

  const showToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const handleSaveConfig = (newUrl, newKey) => {
    const cleanUrl = newUrl.replace(/\/+$/, '');
    setApiUrl(cleanUrl);
    setAdminKey(newKey);
    localStorage.setItem('thecinema_api_url', cleanUrl);
    localStorage.setItem('thecinema_admin_key', newKey);
    showToast('API credentials updated', 'success');
  };

  const fetchTheaters = async () => {
    if (!apiUrl || !adminKey) {
      setIsConfigOpen(true);
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/theaters`, {
        headers: {
          'X-Admin-Key': adminKey,
        },
      });

      if (res.status === 401) {
        showToast('Invalid Admin API Key. Please check settings.', 'error');
        setIsConfigOpen(true);
        return;
      }

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const data = await res.json();
      setTheaters(data.theaters || []);
      setMetrics({
        total: data.total || 0,
        with_custom_image: data.with_custom_image || 0,
        missing_image: data.missing_image || 0,
      });
    } catch (err) {
      showToast(`Failed to load theaters: ${err.message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (apiUrl && adminKey) {
      fetchTheaters();
    } else {
      setIsConfigOpen(true);
    }
  }, [apiUrl, adminKey]);

  // Upload handler
  const handleUploadImage = async (theater, file) => {
    setUploadingSlug(theater.slug);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (theater.theater_id) formData.append('theater_id', theater.theater_id.toString());
      if (theater.name) formData.append('name', theater.name);

      const res = await fetch(`${apiUrl}/api/admin/theaters/${theater.slug}/image`, {
        method: 'POST',
        headers: {
          'X-Admin-Key': adminKey,
        },
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `Upload failed with status ${res.status}`);
      }

      showToast(`Custom photo updated for ${theater.name}!`, 'success');

      // Optimistically update state
      setTheaters((prev) =>
        prev.map((t) =>
          t.slug === theater.slug
            ? {
                ...t,
                has_custom_image: true,
                custom_image_url: json.data.image_url,
                thumbnail_url: json.data.thumbnail_url,
                file_id: json.data.file_id,
              }
            : t
        )
      );

      setMetrics((prev) => ({
        ...prev,
        with_custom_image: prev.with_custom_image + (theater.has_custom_image ? 0 : 1),
        missing_image: Math.max(0, prev.missing_image - (theater.has_custom_image ? 0 : 1)),
      }));
    } catch (err) {
      showToast(`Upload error: ${err.message}`, 'error');
    } finally {
      setUploadingSlug(null);
    }
  };

  // Delete handler
  const handleDeleteImage = async (theater) => {
    try {
      const res = await fetch(`${apiUrl}/api/admin/theaters/${theater.slug}/image`, {
        method: 'DELETE',
        headers: {
          'X-Admin-Key': adminKey,
        },
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `Delete failed with status ${res.status}`);
      }

      showToast(`Removed custom photo for ${theater.name}`, 'info');

      // Optimistically update state
      setTheaters((prev) =>
        prev.map((t) =>
          t.slug === theater.slug
            ? {
                ...t,
                has_custom_image: false,
                custom_image_url: null,
                thumbnail_url: null,
                file_id: null,
              }
            : t
        )
      );

      setMetrics((prev) => ({
        ...prev,
        with_custom_image: Math.max(0, prev.with_custom_image - 1),
        missing_image: prev.missing_image + 1,
      }));
    } catch (err) {
      showToast(`Delete error: ${err.message}`, 'error');
    }
  };

  // Extract unique provinces for filter dropdown
  const provinces = useMemo(() => {
    const set = new Set();
    for (const t of theaters) {
      if (t.province) set.add(t.province);
    }
    return Array.from(set).sort();
  }, [theaters]);

  // Filtered theaters list
  const filteredTheaters = useMemo(() => {
    return theaters.filter((theater) => {
      // 1. Status Filter
      if (statusFilter === 'missing' && theater.has_custom_image) return false;
      if (statusFilter === 'has_image' && !theater.has_custom_image) return false;

      // 2. Province Filter
      if (selectedProvince !== 'all' && theater.province !== selectedProvince) return false;

      // 3. Search Query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesName = (theater.name || '').toLowerCase().includes(query);
        const matchesCity = (theater.city || '').toLowerCase().includes(query);
        const matchesProvince = (theater.province || '').toLowerCase().includes(query);
        if (!matchesName && !matchesCity && !matchesProvince) return false;
      }

      return true;
    });
  }, [theaters, statusFilter, selectedProvince, searchQuery]);

  return (
    <div className="app-layout">
      <Header
        isConnected={isConnected}
        onOpenConfig={() => setIsConfigOpen(true)}
        onRefresh={fetchTheaters}
        isRefreshing={isLoading}
      />

      <main className="main-content">
        <Metrics
          total={metrics.total}
          withCustomImage={metrics.with_custom_image}
          missingImage={metrics.missing_image}
        />

        {/* Search & Filter Controls */}
        <div className="controls-bar">
          <div className="search-box">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Search by theater name, city, or province..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="filters-group">
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button
                className={`tab-pill ${statusFilter === 'missing' ? 'active' : ''}`}
                onClick={() => setStatusFilter('missing')}
              >
                Missing Image ({metrics.missing_image})
              </button>
              <button
                className={`tab-pill ${statusFilter === 'has_image' ? 'active' : ''}`}
                onClick={() => setStatusFilter('has_image')}
              >
                Has Photo ({metrics.with_custom_image})
              </button>
              <button
                className={`tab-pill ${statusFilter === 'all' ? 'active' : ''}`}
                onClick={() => setStatusFilter('all')}
              >
                All ({metrics.total})
              </button>
            </div>

            <select
              className="select-dropdown"
              value={selectedProvince}
              onChange={(e) => setSelectedProvince(e.target.value)}
            >
              <option value="all">All Locations ({provinces.length})</option>
              {provinces.map((prov) => (
                <option key={prov} value={prov}>
                  {prov}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Theater Cards Grid */}
        {isLoading && theaters.length === 0 ? (
          <div className="empty-state">
            <RefreshCw size={40} className="empty-icon spin-animation" />
            <h3>Connecting to The Cinema Worker...</h3>
            <p style={{ marginTop: '0.5rem' }}>Fetching theater snapshots and metadata from D1.</p>
          </div>
        ) : filteredTheaters.length > 0 ? (
          <div className="theaters-grid">
            {filteredTheaters.map((theater) => (
              <TheaterCard
                key={theater.slug}
                theater={theater}
                onUpload={handleUploadImage}
                onDelete={handleDeleteImage}
                onPreview={(url, title) => setPreviewData({ isOpen: true, url, title })}
                isUploading={uploadingSlug === theater.slug}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Film size={40} className="empty-icon" />
            <h3>No theaters found</h3>
            <p style={{ marginTop: '0.5rem' }}>
              {searchQuery || statusFilter !== 'all' || selectedProvince !== 'all'
                ? 'Try adjusting your search query or filter settings.'
                : 'Configure your Worker API URL and Key to load theater snapshots.'}
            </p>
          </div>
        )}
      </main>

      {/* Modals */}
      <ConfigModal
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        apiUrl={apiUrl}
        adminKey={adminKey}
        onSave={handleSaveConfig}
      />

      <LightboxModal
        isOpen={previewData.isOpen}
        imageUrl={previewData.url}
        title={previewData.title}
        onClose={() => setPreviewData({ isOpen: false, url: '', title: '' })}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
