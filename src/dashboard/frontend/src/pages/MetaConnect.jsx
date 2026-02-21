import React, { useState, useEffect } from 'react';
import {
  Facebook, Link2, Unlink, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Clock, Shield, ChevronDown, Key, ExternalLink
} from 'lucide-react';
import {
  getMetaConnectionStatus, getMetaLoginUrl, exchangeMetaToken,
  selectMetaAccount, refreshMetaToken, disconnectMeta
} from '../api';

const MetaConnect = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [manualToken, setManualToken] = useState('');
  const [message, setMessage] = useState(null);
  const [showAccounts, setShowAccounts] = useState(false);

  useEffect(() => {
    loadStatus();

    // Verificar si venimos del callback de OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      setMessage({ type: 'success', text: 'Conexión con Meta establecida exitosamente' });
      window.history.replaceState({}, '', '/meta-connect');
    }
    if (params.get('error')) {
      setMessage({ type: 'error', text: params.get('error') });
      window.history.replaceState({}, '', '/meta-connect');
    }
  }, []);

  const loadStatus = async () => {
    try {
      const data = await getMetaConnectionStatus();
      setStatus(data);
    } catch (error) {
      console.error('Error cargando estado:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = async () => {
    setActionLoading(true);
    try {
      const data = await getMetaLoginUrl();
      window.location.href = data.login_url;
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Error generando URL de login' });
      setActionLoading(false);
    }
  };

  const handleTokenExchange = async () => {
    if (!manualToken.trim()) return;
    setActionLoading(true);
    setMessage(null);
    try {
      const result = await exchangeMetaToken(manualToken.trim());
      setMessage({
        type: 'success',
        text: `Conectado como ${result.user} — ${result.accounts} cuenta(s) encontrada(s) — Token ${result.token_type} válido por ${result.expires_in_days} días`
      });
      setManualToken('');
      setShowTokenInput(false);
      await loadStatus();
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Error al intercambiar token' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSelectAccount = async (accountId) => {
    setActionLoading(true);
    try {
      await selectMetaAccount(accountId);
      setMessage({ type: 'success', text: 'Cuenta publicitaria actualizada' });
      await loadStatus();
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Error seleccionando cuenta' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRefresh = async () => {
    setActionLoading(true);
    try {
      const result = await refreshMetaToken();
      setMessage({ type: result.success ? 'success' : 'warning', text: result.reason });
      await loadStatus();
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Error renovando token' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('¿Estás seguro? El sistema dejará de funcionar hasta que reconectes.')) return;
    setActionLoading(true);
    try {
      await disconnectMeta();
      setMessage({ type: 'success', text: 'Desconectado de Meta' });
      await loadStatus();
    } catch (error) {
      setMessage({ type: 'error', text: 'Error al desconectar' });
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: '#888', fontFamily: 'Inter, system-ui, sans-serif', padding: '40px' }}>
        Cargando estado de conexión...
      </div>
    );
  }

  const isConnected = status?.connected;
  const daysLeft = status?.days_until_expiry;
  const tokenWarning = daysLeft !== null && daysLeft < 10;

  return (
    <div style={{ color: '#fff', fontFamily: 'Inter, system-ui, sans-serif', maxWidth: '900px' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Facebook size={28} />
          Conexión con Meta
        </h1>
        <p style={{ color: '#888', margin: 0, fontSize: '14px' }}>
          Conecta tu cuenta de Facebook para que el sistema acceda a tus campañas publicitarias
        </p>
      </div>

      {/* Mensajes */}
      {message && (
        <div style={{
          padding: '14px 18px',
          borderRadius: '10px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '14px',
          backgroundColor: message.type === 'success' ? '#052e16' : message.type === 'error' ? '#450a0a' : '#422006',
          border: `1px solid ${message.type === 'success' ? '#16a34a' : message.type === 'error' ? '#dc2626' : '#d97706'}`,
          color: message.type === 'success' ? '#86efac' : message.type === 'error' ? '#fca5a5' : '#fcd34d'
        }}>
          {message.type === 'success' ? <CheckCircle size={18} /> : message.type === 'error' ? <XCircle size={18} /> : <AlertTriangle size={18} />}
          {message.text}
          <button onClick={() => setMessage(null)} style={{
            marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px'
          }}>×</button>
        </div>
      )}

      {/* Estado de conexión */}
      <div style={{
        backgroundColor: '#1a1d27',
        borderRadius: '12px',
        border: `1px solid ${isConnected ? '#16a34a' : '#2a2d3a'}`,
        padding: '28px',
        marginBottom: '24px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '12px',
              backgroundColor: isConnected ? '#052e16' : '#1f2937',
              border: `1px solid ${isConnected ? '#16a34a' : '#374151'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              {isConnected ? <CheckCircle size={24} color="#22c55e" /> : <Unlink size={24} color="#6b7280" />}
            </div>
            <div>
              <div style={{ fontSize: '18px', fontWeight: '600' }}>
                {isConnected ? 'Conectado' : 'No Conectado'}
              </div>
              <div style={{ fontSize: '13px', color: '#888' }}>
                {isConnected ? `Usuario: ${status.meta_user_name}` : 'Necesitas conectar tu cuenta de Meta'}
              </div>
            </div>
          </div>

          {isConnected && (
            <button onClick={handleDisconnect} disabled={actionLoading} style={{
              padding: '8px 16px', borderRadius: '8px', border: '1px solid #dc2626',
              backgroundColor: 'transparent', color: '#ef4444', cursor: 'pointer',
              fontSize: '13px', fontWeight: '500', fontFamily: 'Inter, system-ui, sans-serif',
              opacity: actionLoading ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '6px'
            }}>
              <Unlink size={14} /> Desconectar
            </button>
          )}
        </div>

        {isConnected && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
            <div style={{ backgroundColor: '#0f1117', borderRadius: '10px', padding: '16px', border: '1px solid #2a2d3a' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>Cuenta Publicitaria</div>
              <div style={{ fontSize: '15px', fontWeight: '600' }}>{status.ad_account_name || 'Sin seleccionar'}</div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>{status.ad_account_id}</div>
            </div>
            <div style={{ backgroundColor: '#0f1117', borderRadius: '10px', padding: '16px', border: '1px solid #2a2d3a' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>Token</div>
              <div style={{ fontSize: '15px', fontWeight: '600', color: tokenWarning ? '#f59e0b' : '#22c55e' }}>
                {status.token_type === 'long_lived' ? 'Larga duración' : 'Corta duración'}
              </div>
              <div style={{ fontSize: '12px', color: tokenWarning ? '#f59e0b' : '#666', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Clock size={11} />
                {daysLeft !== null ? `Expira en ${daysLeft} días` : 'No expira'}
              </div>
            </div>
            <div style={{ backgroundColor: '#0f1117', borderRadius: '10px', padding: '16px', border: '1px solid #2a2d3a' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>Permisos</div>
              <div style={{ fontSize: '15px', fontWeight: '600' }}>{(status.scopes || []).length} scopes</div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>
                {(status.scopes || []).includes('ads_management') ? 'ads_management OK' : 'Permisos insuficientes'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Acciones de conexión */}
      {!isConnected && (
        <div style={{
          backgroundColor: '#1a1d27', borderRadius: '12px', border: '1px solid #2a2d3a',
          padding: '28px', marginBottom: '24px'
        }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginTop: 0, marginBottom: '20px' }}>
            Métodos de Conexión
          </h3>

          {/* Opción 1: OAuth */}
          <div style={{
            backgroundColor: '#0f1117', borderRadius: '10px', border: '1px solid #2a2d3a',
            padding: '20px', marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Facebook size={18} color="#1877f2" /> Conectar con Facebook
                </div>
                <div style={{ fontSize: '13px', color: '#888' }}>
                  Inicia sesión con tu cuenta de Facebook. El método más fácil y seguro.
                </div>
              </div>
              <button onClick={handleOAuthLogin} disabled={actionLoading} style={{
                padding: '10px 24px', borderRadius: '8px', border: 'none',
                backgroundColor: '#1877f2', color: '#fff', cursor: 'pointer',
                fontSize: '14px', fontWeight: '600', fontFamily: 'Inter, system-ui, sans-serif',
                opacity: actionLoading ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '8px',
                whiteSpace: 'nowrap'
              }}>
                <ExternalLink size={16} />
                {actionLoading ? 'Cargando...' : 'Conectar'}
              </button>
            </div>
          </div>

          {/* Opción 2: Token manual */}
          <div style={{
            backgroundColor: '#0f1117', borderRadius: '10px', border: '1px solid #2a2d3a',
            padding: '20px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: showTokenInput ? '16px' : 0 }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Key size={18} color="#f59e0b" /> Pegar Token Manualmente
                </div>
                <div style={{ fontSize: '13px', color: '#888' }}>
                  Si ya tienes un token de acceso de Meta, pégalo aquí directamente.
                </div>
              </div>
              <button onClick={() => setShowTokenInput(!showTokenInput)} style={{
                padding: '10px 24px', borderRadius: '8px', border: '1px solid #374151',
                backgroundColor: 'transparent', color: '#d1d5db', cursor: 'pointer',
                fontSize: '14px', fontWeight: '500', fontFamily: 'Inter, system-ui, sans-serif',
                display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap'
              }}>
                <ChevronDown size={16} style={{ transform: showTokenInput ? 'rotate(180deg)' : 'none', transition: '0.2s' }} />
                {showTokenInput ? 'Cerrar' : 'Usar Token'}
              </button>
            </div>

            {showTokenInput && (
              <div>
                <textarea
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Pega tu access token de Meta aquí..."
                  style={{
                    width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #2a2d3a',
                    backgroundColor: '#1a1d27', color: '#fff', fontSize: '13px', fontFamily: 'monospace',
                    resize: 'vertical', minHeight: '80px', outline: 'none', boxSizing: 'border-box'
                  }}
                  onFocus={(e) => { e.target.style.borderColor = '#3b82f6'; }}
                  onBlur={(e) => { e.target.style.borderColor = '#2a2d3a'; }}
                />
                <button onClick={handleTokenExchange} disabled={actionLoading || !manualToken.trim()} style={{
                  marginTop: '12px', padding: '10px 24px', borderRadius: '8px', border: 'none',
                  backgroundColor: '#f59e0b', color: '#000', cursor: 'pointer',
                  fontSize: '14px', fontWeight: '600', fontFamily: 'Inter, system-ui, sans-serif',
                  opacity: (actionLoading || !manualToken.trim()) ? 0.5 : 1
                }}>
                  {actionLoading ? 'Verificando...' : 'Conectar con Token'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Selección de cuenta publicitaria */}
      {isConnected && status.available_accounts && status.available_accounts.length > 1 && (
        <div style={{
          backgroundColor: '#1a1d27', borderRadius: '12px', border: '1px solid #2a2d3a',
          padding: '28px', marginBottom: '24px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>
              Cuentas Publicitarias ({status.available_accounts.length})
            </h3>
            <button onClick={() => setShowAccounts(!showAccounts)} style={{
              padding: '6px 14px', borderRadius: '6px', border: '1px solid #374151',
              backgroundColor: 'transparent', color: '#d1d5db', cursor: 'pointer',
              fontSize: '13px', fontFamily: 'Inter, system-ui, sans-serif'
            }}>
              {showAccounts ? 'Ocultar' : 'Cambiar cuenta'}
            </button>
          </div>

          {showAccounts && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {status.available_accounts.map(acc => (
                <div key={acc.id} style={{
                  padding: '14px 16px', borderRadius: '8px',
                  border: `1px solid ${acc.id === status.ad_account_id ? '#3b82f6' : '#2a2d3a'}`,
                  backgroundColor: acc.id === status.ad_account_id ? '#172554' : '#0f1117',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: 'pointer'
                }} onClick={() => handleSelectAccount(acc.id)}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{acc.name}</div>
                    <div style={{ fontSize: '12px', color: '#888' }}>{acc.id} — {acc.currency} — {acc.timezone_name}</div>
                  </div>
                  {acc.id === status.ad_account_id && (
                    <div style={{
                      padding: '4px 10px', borderRadius: '6px', backgroundColor: '#1d4ed8',
                      fontSize: '11px', fontWeight: '600', color: '#dbeafe'
                    }}>
                      ACTIVA
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Acciones cuando está conectado */}
      {isConnected && (
        <div style={{
          backgroundColor: '#1a1d27', borderRadius: '12px', border: '1px solid #2a2d3a',
          padding: '28px'
        }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginTop: 0, marginBottom: '16px' }}>
            Mantenimiento del Token
          </h3>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button onClick={handleRefresh} disabled={actionLoading} style={{
              padding: '10px 20px', borderRadius: '8px', border: '1px solid #2a2d3a',
              backgroundColor: '#0f1117', color: '#d1d5db', cursor: 'pointer',
              fontSize: '14px', fontWeight: '500', fontFamily: 'Inter, system-ui, sans-serif',
              display: 'flex', alignItems: 'center', gap: '8px',
              opacity: actionLoading ? 0.5 : 1
            }}>
              <RefreshCw size={16} /> Renovar Token
            </button>

            <button onClick={handleOAuthLogin} disabled={actionLoading} style={{
              padding: '10px 20px', borderRadius: '8px', border: '1px solid #1877f2',
              backgroundColor: 'transparent', color: '#60a5fa', cursor: 'pointer',
              fontSize: '14px', fontWeight: '500', fontFamily: 'Inter, system-ui, sans-serif',
              display: 'flex', alignItems: 'center', gap: '8px',
              opacity: actionLoading ? 0.5 : 1
            }}>
              <Facebook size={16} /> Reconectar con Facebook
            </button>
          </div>

          {tokenWarning && (
            <div style={{
              marginTop: '16px', padding: '12px 16px', borderRadius: '8px',
              backgroundColor: '#422006', border: '1px solid #d97706',
              fontSize: '13px', color: '#fcd34d', display: 'flex', alignItems: 'center', gap: '8px'
            }}>
              <AlertTriangle size={16} />
              El token expira en {daysLeft} días. Renuévalo o reconecta para evitar interrupciones.
            </div>
          )}

          <div style={{ marginTop: '16px', fontSize: '12px', color: '#666' }}>
            <Shield size={12} style={{ display: 'inline', marginRight: '4px' }} />
            El token se renueva automáticamente cada 50 días. Si el token expira, el sistema dejará de funcionar hasta que reconectes.
          </div>
        </div>
      )}
    </div>
  );
};

export default MetaConnect;
