import React, { createContext, useState, useContext, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './api';
import Login from './pages/Login';
import AdSetsManager from './pages/AdSetsManager';
import BrainIntelligence from './pages/BrainIntelligence';
import BrainOS from './pages/BrainOS';

// AuthContext
const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth debe ser usado dentro de AuthProvider');
  }
  return context;
};

// AuthProvider Component
const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    setIsAuthenticated(!!token);
    setLoading(false);
  }, []);

  const login = () => setIsAuthenticated(true);
  const logout = () => setIsAuthenticated(false);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', backgroundColor: '#09090b', color: '#71717a',
        fontFamily: 'Inter, system-ui, sans-serif', fontSize: '14px'
      }}>
        Loading...
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

// Protected Route
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
};

// Main App
function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AdSetsManager />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brain"
            element={
              <ProtectedRoute>
                <BrainIntelligence />
              </ProtectedRoute>
            }
          />
          <Route
            path="/brain-os"
            element={
              <ProtectedRoute>
                <BrainOS />
              </ProtectedRoute>
            }
          />
          {/* Catch-all redirect to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
