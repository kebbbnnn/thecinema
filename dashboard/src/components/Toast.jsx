import React from 'react';
import { CheckCircle, AlertTriangle, Info } from 'lucide-react';

export function ToastContainer({ toasts }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item toast-${toast.type || 'info'}`}>
          {toast.type === 'success' && <CheckCircle size={18} />}
          {toast.type === 'error' && <AlertTriangle size={18} />}
          {toast.type === 'info' && <Info size={18} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
