/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'info';
  onClose: () => void;
  duration?: number;
}

export default function Toast({ message, type, onClose, duration = 4000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [onClose, duration]);

  const getStyles = () => {
    switch (type) {
      case 'success':
        return {
          bg: 'bg-emerald-50 border-emerald-200 text-emerald-800',
          icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
        };
      case 'error':
        return {
          bg: 'bg-rose-50 border-rose-200 text-rose-800',
          icon: <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
        };
      case 'info':
      default:
        return {
          bg: 'bg-indigo-50 border-indigo-200 text-indigo-800',
          icon: <Info className="w-5 h-5 text-indigo-600 shrink-0" />
        };
    }
  };

  const styles = getStyles();

  return (
    <div 
      className={`fixed bottom-5 left-5 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-lg max-w-sm font-sans text-left ${styles.bg} animate-in slide-in-from-bottom-5 duration-300`}
      dir="ltr"
    >
      {styles.icon}
      <span className="text-xs font-bold leading-relaxed">{message}</span>
      <button 
        onClick={onClose} 
        className="p-1 hover:bg-black/5 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer mr-auto"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
