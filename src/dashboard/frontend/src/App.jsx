import React, { createContext, useState, useContext, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Layers,
  Bot,
  Shield,
  Settings,
  Facebook,
  BarChart3,
  Menu,
  X,
  Palette,
  Rocket
} from 'lucide-react';
import { getToken, getControlsStatus } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AdSetsPage from './pages/AdSets';
import ControlsPage from './pages/Controls';
import SettingsPageComponent from './pages/Settings';
import MetaConnect from './pages/MetaConnect';
import AgentsPage from './pages/Agents';
import CreativeBank from './pages/CreativeBank';
import AdSetCreator from './pages/AdSetCreator';
import ImpactReport from './pages/ImpactReport';

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

  const login = () => {
    setIsAuthenticated(true);
  };

  const logout = () => {
    setIsAuthenticated(false);
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#0a0a0a',
        color: '#fff',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}>
        Cargando...
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

// Protected Route Component
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

// Sidebar Component
const SIDEBAR_WIDTH = 220;
const SIDEBAR_COLLAPSED = 60;

const Sidebar = ({ collapsed, onToggle }) => {
  const location = useLocation();
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    const fetchControlsStatus = async () => {
      try {
        const status = await getControlsStatus();
        setAiEnabled(status.ai_enabled || false);
      } catch (error) {
        console.error('Error al obtener estado de controles:', error);
      }
    };

    fetchControlsStatus();
    const interval = setInterval(fetchControlsStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const navItems = [
    { path: '/', icon: LayoutDashboard, label: 'Resumen' },
    { path: '/adsets', icon: Layers, label: 'Ad Sets' },
    { path: '/agents', icon: Bot, label: 'Centro IA' },
    { path: '/creatives', icon: Palette, label: 'Banco Creativo' },
    { path: '/adset-creator', icon: Rocket, label: 'Crear Ad Set' },
    { path: '/impact', icon: BarChart3, label: 'Impacto' },
    { path: '/controls', icon: Shield, label: 'Controles' },
    { path: '/meta-connect', icon: Facebook, label: 'Meta' },
    { path: '/settings', icon: Settings, label: 'Config' },
  ];

  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div
          className="sidebar-overlay"
          onClick={onToggle}
          style={{
            display: 'none',
            position: 'fixed', inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            zIndex: 998
          }}
        />
      )}

      <div className={`app-sidebar ${collapsed ? 'collapsed' : ''}`} style={{
        width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH,
        height: '100vh',
        backgroundColor: '#111',
        borderRight: '1px solid #1f2937',
        display: 'flex',
        flexDirection: 'column',
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 999,
        transition: 'width 0.2s ease, transform 0.2s ease',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: collapsed ? '16px 0' : '16px',
          borderBottom: '1px solid #1f2937',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          minHeight: '56px'
        }}>
          {!collapsed && (
            <span style={{
              fontSize: '15px',
              fontWeight: '700',
              color: '#fff',
              fontFamily: 'Inter, system-ui, sans-serif',
              letterSpacing: '-0.02em',
              whiteSpace: 'nowrap'
            }}>
              JP AI Controller
            </span>
          )}
          <button onClick={onToggle} style={{
            background: 'none', border: 'none', color: '#6b7280',
            cursor: 'pointer', padding: '4px', borderRadius: '4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            {collapsed ? <Menu size={18} /> : <X size={16} />}
          </button>
        </div>

        {/* Navigation */}
        <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;

            return (
              <Link
                key={item.path}
                to={item.path}
                title={collapsed ? item.label : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: collapsed ? '10px 0' : '10px 16px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  color: isActive ? '#fff' : '#6b7280',
                  textDecoration: 'none',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  fontSize: '13px',
                  fontWeight: isActive ? '600' : '500',
                  backgroundColor: isActive ? '#1a1a2e' : 'transparent',
                  borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                  transition: 'all 0.15s ease',
                  gap: '10px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = '#161620';
                    e.currentTarget.style.color = '#9ca3af';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#6b7280';
                  }
                }}
              >
                <Icon size={17} style={{ flexShrink: 0 }} />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Mode Badge */}
        <div style={{
          padding: collapsed ? '12px 6px' : '12px 16px',
          borderTop: '1px solid #1f2937'
        }}>
          <div style={{
            padding: collapsed ? '6px' : '8px 12px',
            borderRadius: '6px',
            backgroundColor: aiEnabled ? '#1e3a8a' : '#374151',
            border: `1px solid ${aiEnabled ? '#3b82f6' : '#4b5563'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <span style={{
              color: aiEnabled ? '#93c5fd' : '#9ca3af',
              fontSize: collapsed ? '9px' : '11px',
              fontWeight: '700',
              fontFamily: 'Inter, system-ui, sans-serif',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }}>
              {collapsed ? (aiEnabled ? 'ON' : 'OFF') : (aiEnabled ? 'IA Activa' : 'IA Off')}
            </span>
          </div>
        </div>
      </div>
    </>
  );
};

// Layout Component
const DashboardLayout = ({ children }) => {
  const [collapsed, setCollapsed] = useState(() => {
    // Start collapsed on smaller screens
    if (typeof window !== 'undefined') {
      return window.innerWidth < 1200;
    }
    return false;
  });

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 900) {
        setCollapsed(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div style={{
      display: 'flex',
      backgroundColor: '#0a0a0a',
      minHeight: '100vh'
    }}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <main style={{
        marginLeft: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH,
        flex: 1,
        padding: '24px',
        fontFamily: 'Inter, system-ui, sans-serif',
        transition: 'margin-left 0.2s ease',
        minWidth: 0
      }}>
        {children}
      </main>

      {/* Responsive CSS for mobile */}
      <style>{`
        @media (max-width: 768px) {
          .app-sidebar {
            transform: translateX(-100%) !important;
            width: ${SIDEBAR_WIDTH}px !important;
          }
          .app-sidebar:not(.collapsed) {
            transform: translateX(0) !important;
          }
          .sidebar-overlay {
            display: block !important;
          }
          main {
            margin-left: 0 !important;
            padding: 16px !important;
          }
        }
      `}</style>
    </div>
  );
};

// Main App Component
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
                <DashboardLayout>
                  <Dashboard />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/adsets"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <AdSetsPage />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/agents"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <AgentsPage />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/creatives"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <CreativeBank />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/adset-creator"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <AdSetCreator />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/impact"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <ImpactReport />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/controls"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <ControlsPage />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/meta-connect"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <MetaConnect />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <DashboardLayout>
                  <SettingsPageComponent />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
